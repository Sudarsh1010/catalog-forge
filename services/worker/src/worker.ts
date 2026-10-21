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

import type { Db } from "@workspace/db"
import type { Job } from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import type { WorkerConfig } from "./config"
import { resolveConfig } from "./config"
import type { HandlerRegistry } from "./handlers"
import type { ClaimedJob } from "./jobs"
import {
  claimJob,
  completeJob,
  failJob,
  heartbeatJob,
  sweepExpiredJobs,
} from "./jobs"

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
}

/** Reassemble a full Job row around a claim (lease fields reflect the claim). */
function asJob(claimed: ClaimedJob, workerId: string): Job {
  return {
    ...claimed,
    status: "running",
    leaseOwner: workerId,
    leaseExpiresAt: null,
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
      await completeJob(db.db, config, claimed.id)
      log.info(`job completed`, {
        stage: claimed.stage,
        batchKey: claimed.batchKey,
        workerId: config.workerId,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await failJob(db.db, config, claimed.id, reason)
      log.error(`job failed`, {
        stage: claimed.stage,
        batchKey: claimed.batchKey,
        workerId: config.workerId,
        reason,
      })
    }
  }

  async function claimTick(): Promise<void> {
    for (let i = 0; i < config.batchSize; i++) {
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
    const ids = await sweepExpiredJobs(db.db, config)
    if (ids.length > 0) {
      log.info(`sweeper reclaimed expired jobs`, {
        count: ids.length,
        workerId: config.workerId,
      })
    }
  }

  function schedule(fn: () => Promise<void>, ms: number): NodeJS.Timeout {
    const run = async (): Promise<void> => {
      try {
        await fn()
      } catch (error) {
        log.error(`loop iteration failed`, {
          error: error instanceof Error ? error.message : String(error),
          workerId: config.workerId,
        })
      }
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
      for (const timer of timers.splice(0)) clearTimeout(timer)
      started = false
      await Promise.allSettled(inFlight.values())
      inFlight.clear()
    },
  }
}
