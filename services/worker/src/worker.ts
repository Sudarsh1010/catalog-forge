/**
 * The Worker: one process, all loops (spec "Runtime shape").
 *
 * Loops: claim (~250ms default), heartbeat, and the safety-net Sweeper
 * (~30s default). Intervals, lease TTL and the clock are injectable via
 * {@link WorkerConfig} so integration tests run the real loops without
 * sleeping real 30s. Tests observe behavior through Postgres state only —
 * never through worker internals.
 */
import { sql } from "drizzle-orm"

import type { Cache } from "@workspace/cache"
import type { Db } from "@workspace/db"
import type { Job } from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import { publishImportEvent } from "./events"
import type { WorkerConfig } from "./config"
import { resolveConfig } from "./config"
import { backoffDelayMs } from "./backoff"
import type { HandlerRegistry } from "./handlers"
import { adoptQueuedImports, sweepStalledStageAdvances } from "./imports"
import { enterProviderPause, resumeExpiredPauses } from "./pause"
import type { PoisonHandler } from "./poison"
import { adoptJobRetries } from "./retries"
import { adoptReruns } from "./reruns"
import type { StagePlannerRegistry } from "./stages"
import type { ClaimedJob } from "./jobs"
import {
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  requeueJob,
  sweepExpiredJobs,
} from "./jobs"
import { ProviderError } from "./provider/port"

const log = createLogger({ service: "worker" })

export interface WorkerHandle {
  readonly workerId: string
  /** Start all loops. Idempotent. */
  start(): void
  /** Stop all loops and wait for in-flight handler executions to settle. */
  stop(): Promise<void>
  /** True while the worker has at least one handler execution in flight. */
  isBusy(): boolean
}

export interface CreateWorkerOptions {
  db: Db
  handlers: HandlerRegistry
  config?: Partial<WorkerConfig>
  /**
   * Redis client for the per-Import progress streams. When present, the
   * machinery publishes `job_completed` facts as Jobs finish; handlers own
   * the Import-level events (stage_changed, import_done).
   */
  cache?: Cache
  /**
   * Stage planners (ADR-0002 plan-then-execute): invoked inside the
   * completion transaction that advances the Import, so the next Stage's
   * Jobs are planned the moment its stage value flips.
   */
  planners?: StagePlannerRegistry
  /**
   * Poison path (ADR-0003): what a terminally Failed Job means for the
   * domain — per Stage, because only the Stage knows which Sheet Rows its
   * Batch covers. `main.ts` registers the enrich/translate writer that
   * records Failed-with-reason in the Row Ledger; the dashboard retry
   * requeues the Job afterwards.
   */
  poisonHandlers?: Record<string, PoisonHandler>
}

/** Reassemble a full Job row around a claim (lease fields reflect the claim). */
function asJob(claimed: ClaimedJob, workerId: string): Job {
  return {
    ...claimed,
    status: "running",
    leaseOwner: workerId,
    leaseExpiresAt: null,
    availableAt: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

export function createWorker(options: CreateWorkerOptions): WorkerHandle {
  const config = resolveConfig(options.config)
  const { db } = options
  /** In-flight handler executions by job id — heartbeat input and stop barrier. */
  const inFlight = new Map<string, Promise<void>>()
  /** Running loop ticks — stop() lets them settle before declaring quiet. */
  const ticks = new Set<Promise<void>>()
  const timers: NodeJS.Timeout[] = []
  let started = false

  /** Execute an already-claimed Job through the registry, recording the outcome. */
  async function execute(claimed: ClaimedJob): Promise<void> {
    const handler = options.handlers[claimed.stage]
    if (!handler) {
      await failJob(
        db.db,
        config,
        claimed.id,
        `no handler registered for stage "${claimed.stage}"`
      )
      return
    }
    try {
      await handler({ job: asJob(claimed, config.workerId), db: db.db, log })
      const { advancedTo } = await completeJob(
        db.db,
        config,
        claimed.id,
        options.planners
      )
      if (options.cache) {
        await publishImportEvent(options.cache, {
          importId: claimed.importId,
          type: "job_completed",
          data: {
            importId: claimed.importId,
            stage: claimed.stage,
            batchKey: claimed.batchKey,
          },
        })
        if (advancedTo) {
          await publishImportEvent(options.cache, {
            importId: claimed.importId,
            type: "stage_changed",
            data: {
              importId: claimed.importId,
              from: claimed.stage,
              to: advancedTo,
            },
          })
        }
      }
      log.info(`job completed`, {
        stage: claimed.stage,
        batchKey: claimed.batchKey,
        workerId: config.workerId,
        advancedTo,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await recordFault(claimed, error, reason)
    }
  }

  /**
   * Fault policy (EC-082's three classes, three behaviors). Provider faults
   * on provider-stamped Jobs never consume the lease machinery's blunt
   * failJob path while they are still retryable:
   *
   *   - `rate_limited` → the provider's Pause engages, honoring Retry-After;
   *     the Job requeues to claim exactly when the Pause lifts and the
   *     attempt is refunded (throttling is the provider's signal, not the
   *     Job's failure). Other providers keep working; the affected Imports
   *     surface "Paused — resuming in X minutes" plus a `paused` event.
   *   - `server_error` / `timeout` / `invalid_json` → exponential backoff
   *     with jitter; attempts still count, so a permanently broken call
   *     exhausts maxAttempts and terminates via the poison path.
   *   - anything else (wiring bugs, contract violations) → failJob, whose
   *     terminal outcome records the Row Ledger consequences.
   */
  async function recordFault(
    claimed: ClaimedJob,
    error: unknown,
    reason: string
  ): Promise<void> {
    const fault = error instanceof ProviderError ? error.fault : null
    if (fault && claimed.providerId) {
      if (fault.class === "rate_limited") {
        const retryAfterMs = fault.retryAfterMs ?? config.rateLimitRetryAfterMs
        await requeueJob(db.db, config, claimed.id, {
          delayMs: retryAfterMs,
          refundAttempt: true,
          reason,
        })
        const entered = await enterProviderPause(db.db, {
          storeId: claimed.storeId,
          providerId: claimed.providerId,
          resumeAtMs: config.now() + retryAfterMs,
          reason,
        })
        if (options.cache) {
          for (const importId of entered.affectedImportIds) {
            await publishImportEvent(options.cache, {
              importId,
              type: "paused",
              data: {
                importId,
                providerId: claimed.providerId,
                resumeAt: entered.resumeAt,
                reason,
              },
            })
          }
        }
        log.warn(`provider paused — resuming per Retry-After`, {
          providerId: claimed.providerId,
          retryAfterMs,
          affectedImports: entered.affectedImportIds.length,
          workerId: config.workerId,
        })
        return
      }
      // Backoff rides on the Job's own poison counter (max_attempts): the
      // row is authoritative — config.maxAttempts only seeds planners.
      if (claimed.attempts < claimed.maxAttempts) {
        const delayMs = backoffDelayMs(claimed.attempts, {
          baseMs: config.backoffBaseMs,
          maxMs: config.backoffMaxMs,
          jitter: config.jitter,
        })
        await requeueJob(db.db, config, claimed.id, {
          delayMs,
          refundAttempt: false,
          reason,
        })
        log.warn(`job requeued with backoff`, {
          stage: claimed.stage,
          batchKey: claimed.batchKey,
          faultClass: fault.class,
          attempt: claimed.attempts,
          delayMs,
          workerId: config.workerId,
        })
        return
      }
    }
    const terminal = await failJob(db.db, config, claimed.id, reason)
    if (terminal) {
      const poison = options.poisonHandlers?.[claimed.stage]
      if (poison) {
        try {
          await poison(
            db.db,
            {
              storeId: claimed.storeId,
              importId: claimed.importId,
              stage: claimed.stage,
              batchKey: claimed.batchKey,
              attempts: claimed.attempts,
            },
            reason
          )
        } catch (poisonError) {
          // The Job is already terminally Failed; a broken ledger writer
          // must not escape as an unhandled rejection on top of it.
          log.error(`poison handler failed after terminal job failure`, {
            stage: claimed.stage,
            jobId: claimed.id,
            error:
              poisonError instanceof Error
                ? poisonError.message
                : String(poisonError),
            workerId: config.workerId,
          })
        }
      }
      log.error(`job failed terminally — poison path recorded`, {
        stage: claimed.stage,
        batchKey: claimed.batchKey,
        jobId: claimed.id,
        attempts: claimed.attempts,
        reason,
        workerId: config.workerId,
      })
      return
    }
    log.error(`job failed`, {
      stage: claimed.stage,
      batchKey: claimed.batchKey,
      workerId: config.workerId,
      reason,
    })
  }

  async function claimTick(): Promise<void> {
    // Automatic Pause resume (GLOSSARY: Pause — "resuming in X minutes"):
    // checked on the fast loop so a lifted Pause hands Jobs back within one
    // claim interval, with no human action.
    const resumed = await resumeExpiredPauses(db.db, config.now())
    for (const pause of resumed) {
      log.info(`provider Pause lifted — Import resumed`, {
        ...pause,
        workerId: config.workerId,
      })
    }
    for (let i = 0; i < config.batchSize; i++) {
      // A stop() during this tick must not claim fresh work (a residual
      // tick can wake long after stop began when the pool was saturated).
      if (!started) return
      const claimed = await claimJob(db.db, config)
      if (!claimed) return
      const execution = execute(claimed).finally(() =>
        inFlight.delete(claimed.id)
      )
      inFlight.set(claimed.id, execution)
    }
  }

  /** Renew the lease on every Job this worker currently holds. */
  async function heartbeatTick(): Promise<void> {
    const rows = await db.db.execute(sql`
      SELECT id FROM jobs WHERE status = 'running' AND lease_owner = ${config.workerId}
    `)
    for (const row of rows as unknown as Array<{ id: string }>) {
      const alive = await heartbeatJob(db.db, config, row.id)
      if (!alive)
        log.error(`lost lease on job`, {
          jobId: row.id,
          workerId: config.workerId,
        })
    }
  }

  async function sweepTick(): Promise<void> {
    // Safety net, part 1: adopt Imports the web app queued (ADR-0004) so a
    // fresh upload becomes claimable work at the next sweep.
    const adopted = await adoptQueuedImports(db.db)
    if (adopted > 0) {
      log.info(`sweeper adopted queued imports`, {
        count: adopted,
        workerId: config.workerId,
      })
    }
    // Safety net, part 1b: adopt dashboard retry requests (ADR-0004) — the
    // poison path's re-entry point. The Job requeues with reset attempts.
    const retried = await adoptJobRetries(db.db)
    for (const retry of retried) {
      log.info(`sweeper adopted retry request — poison job requeued`, {
        ...retry,
        workerId: config.workerId,
      })
    }
    // Safety net, part 1c: adopt Re-run requests (ADR-0004) — the enrich
    // Jobs covering the chosen Products requeue with reset attempts.
    const reran = await adoptReruns(db.db)
    for (const rerun of reran) {
      log.info(`sweeper adopted re-run request — enrich jobs requeued`, {
        ...rerun,
        workerId: config.workerId,
      })
    }
    // Safety net, part 2: reclaim Jobs whose leases expired (ADR-0003).
    const ids = await sweepExpiredJobs(db.db, config)
    if (ids.length > 0) {
      log.info(`sweeper reclaimed expired jobs`, {
        count: ids.length,
        workerId: config.workerId,
      })
    }
    // Safety net, part 3: advance Imports stranded mid-Stage and plan the
    // next Stage's Jobs (ADR-0002's self-healing sweeper).
    const advanced = await sweepStalledStageAdvances(db.db, options.planners)
    for (const advance of advanced) {
      log.info(`sweeper advanced stalled stage`, {
        ...advance,
        workerId: config.workerId,
      })
      if (options.cache) {
        await publishImportEvent(options.cache, {
          importId: advance.importId,
          type: "stage_changed",
          data: {
            importId: advance.importId,
            from: advance.from,
            to: advance.to,
          },
        })
      }
    }
  }

  function schedule(fn: () => Promise<void>, ms: number): NodeJS.Timeout {
    const run = async (): Promise<void> => {
      const tick = (async () => {
        try {
          await fn()
        } catch (error) {
          log.error(`loop iteration failed`, {
            error: error instanceof Error ? error.message : String(error),
            workerId: config.workerId,
          })
        }
      })()
      ticks.add(tick)
      void tick.finally(() => ticks.delete(tick))
    }
    void run()
    return setInterval(() => void run(), ms)
  }

  return {
    workerId: config.workerId,
    isBusy: () => inFlight.size > 0,
    start() {
      if (started) return
      started = true
      timers.push(schedule(claimTick, config.claimIntervalMs))
      timers.push(schedule(heartbeatTick, config.heartbeatIntervalMs))
      timers.push(schedule(sweepTick, config.sweepIntervalMs))
    },
    async stop() {
      started = false
      for (const timer of timers.splice(0)) clearTimeout(timer)
      // Let the current loop ticks finish FIRST (they may still claim), so
      // their executions are registered in inFlight before the barrier.
      await Promise.allSettled(ticks)
      ticks.clear()
      await Promise.allSettled(inFlight.values())
      inFlight.clear()
    },
  }
}
