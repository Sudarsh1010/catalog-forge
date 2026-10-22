/**
 * Job machinery against the Postgres Work Queue (ADR-0001, ADR-0003).
 *
 * All state transitions live here so tests can exercise them directly and the
 * loops stay thin. Claims use `SELECT … FOR UPDATE SKIP LOCKED`, so multiple
 * workers never take the same Job.
 */
import { sql, type SQL } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { Job } from "@workspace/db/schema"
import { isStage, nextStage, type Stage } from "@workspace/pipeline"

import type { WorkerConfig } from "./config"
import type { StagePlannerRegistry } from "./stages"

/** The subset of a Job row the machinery touches. */
export type ClaimedJob = Pick<
  Job,
  | "id"
  | "storeId"
  | "importId"
  | "stage"
  | "batchKey"
  | "attempts"
  | "maxAttempts"
  | "providerId"
  | "routingTier"
>

/** snake_case shape of the `RETURNING id, store_id, …` projection in `claimJob`. */
interface ClaimedRow {
  id: string
  store_id: string
  import_id: string
  stage: string
  batch_key: string
  attempts: number
  max_attempts: number
  provider_id: string | null
  routing_tier: string | null
}

/**
 * Drizzle's postgres-js `db.execute` resolves to a postgres.js RowList — an
 * array of the query's rows. Every raw SQL statement below returns a
 * hand-written `RETURNING` projection, so casting the RowList to that named
 * row type once at the boundary is exact, not fabricated. Shared with the
 * Import machinery (imports.ts), which follows the same pattern.
 */
export function rowsOf<T>(result: unknown): T[] {
  return result as T[]
}

/** Atomically claim one pending Job under a fresh lease. `null` if no work. */
export async function claimJob(
  db: Database,
  config: WorkerConfig
): Promise<ClaimedJob | null> {
  // postgres.js cannot bind Date objects through drizzle raw templates — ISO works.
  const leaseExpiresAt = new Date(
    config.now() + config.leaseTtlMs
  ).toISOString()
  //
  // Stage gate (EC-123): a Job is claimable only when its Stage is at or
  // before the Import's current Stage. The barrier fan-out plans enrich and
  // translate Batches while the Import still sits in `match-media`; without
  // the gate, claim-order (created_at, id) would run them before media
  // matching — and translate before enrich — finished. The fixed machine
  // (ADR-0002) already advances the Import only when a Stage's last Job
  // completes, so the gate serializes stages exactly, with deterministic
  // Batch boundaries untouched. Non-pipeline stages (and Jobs whose Import
  // row is gone) order as 0/99 and stay claimable.
  const stageOrder = (column: "jobs" | "imports"): SQL =>
    column === "jobs"
      ? sql`CASE j.stage
              WHEN 'intake' THEN 1 WHEN 'clean' THEN 2 WHEN 'group' THEN 3
              WHEN 'match-media' THEN 4 WHEN 'enrich' THEN 5
              WHEN 'translate' THEN 6 WHEN 'finalise' THEN 7
              ELSE 0 END`
      : sql`CASE i.stage
              WHEN 'intake' THEN 1 WHEN 'clean' THEN 2 WHEN 'group' THEN 3
              WHEN 'match-media' THEN 4 WHEN 'enrich' THEN 5
              WHEN 'translate' THEN 6 WHEN 'finalise' THEN 7
              ELSE 99 END`
  const rows = rowsOf<ClaimedRow>(
    await db.execute(sql`
      UPDATE jobs SET
        status = 'running',
        attempts = attempts + 1,
        lease_owner = ${config.workerId},
        lease_expires_at = ${leaseExpiresAt},
        last_error = NULL,
        updated_at = now()
      WHERE id = (
        SELECT j.id FROM jobs j
        LEFT JOIN imports i ON i.id = j.import_id
        WHERE j.status = 'pending'
          AND ${stageOrder("jobs")} <= ${stageOrder("imports")}
          -- Backoff/Pause requeues stay asleep until their delay elapses (EC-082).
          AND (j.available_at IS NULL OR j.available_at <= now())
          -- Pause (GLOSSARY): a throttled provider's Jobs are not claimable
          -- across ALL Imports; other providers keep working. provider_id
          -- is stamped at plan time, NULL for non-provider Stages.
          AND NOT EXISTS (
            SELECT 1 FROM provider_pauses pp
            WHERE pp.store_id = j.store_id AND pp.provider_id = j.provider_id
          )
        ORDER BY j.created_at, j.id
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, store_id, import_id, stage, batch_key, attempts, max_attempts,
                provider_id, routing_tier
    `)
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    storeId: row.store_id,
    importId: row.import_id,
    stage: row.stage,
    batchKey: row.batch_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    providerId: row.provider_id,
    routingTier: row.routing_tier,
  }
}

/** Renew this worker's lease on a running Job. Returns false if it was lost. */
export async function heartbeatJob(
  db: Database,
  config: WorkerConfig,
  jobId: string
): Promise<boolean> {
  const leaseExpiresAt = new Date(
    config.now() + config.leaseTtlMs
  ).toISOString()
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE jobs SET
        lease_expires_at = ${leaseExpiresAt},
        updated_at = now()
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${config.workerId}
      RETURNING id
    `)
  )
  return rows.length > 0
}

/**
 * Mark a Job completed. When this completion leaves no other pending or
 * running Job in the same (Import, Stage), the Import advances to the next
 * Stage of the fixed machine inside the SAME transaction (ADR-0002: the
 * last job of a stage advances the Import and plans the next stage in its
 * completion transaction). The next Stage's planner — when one is
 * registered — runs in that transaction too; a missing planner only means
 * the stage value advances (its ticket plugs planning in later).
 *
 * Returns the Stage advanced to, or `null` when the lease was lost (no-op)
 * or the Import did not advance yet (siblings outstanding).
 */
export async function completeJob(
  db: Database,
  config: WorkerConfig,
  jobId: string,
  planners?: StagePlannerRegistry
): Promise<{ advancedTo: Stage | null }> {
  return db.transaction(async (tx) => {
    const completed = rowsOf<{
      import_id: string
      store_id: string
      stage: string
    }>(
      await tx.execute(sql`
        UPDATE jobs SET
          status = 'completed',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
        WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${config.workerId}
        RETURNING import_id, store_id, stage
      `)
    )
    const row = completed[0]
    if (!row) return { advancedTo: null } // lease lost; another worker owns it
    if (!isStage(row.stage)) return { advancedTo: null } // non-pipeline stage
    const next = nextStage(row.stage)
    if (!next) return { advancedTo: null } // end of the pipeline

    const advanced = rowsOf<{ id: string }>(
      await tx.execute(sql`
        UPDATE imports SET
          stage = ${next},
          updated_at = now()
        WHERE id = ${row.import_id} AND status = 'running' AND stage = ${row.stage}
          AND NOT EXISTS (
            SELECT 1 FROM jobs
            WHERE import_id = ${row.import_id} AND stage = ${row.stage}
              AND status IN ('pending', 'running') AND id <> ${jobId}
          )
        RETURNING id
      `)
    )
    if (advanced.length === 0) return { advancedTo: null }

    const planner = planners?.[next]
    if (planner) {
      await planner(tx, { importId: row.import_id, storeId: row.store_id })
    }
    return { advancedTo: next }
  })
}

/**
 * Mark a Job failed. If attempts are exhausted it terminates as `failed`
 * with the reason; otherwise it returns to `pending` for another claim.
 * Attempts are incremented at claim time, so this never bumps the counter.
 * Returns `true` when the Job became terminally Failed (the poison path —
 * the caller records the Row Ledger consequences).
 */
export async function failJob(
  db: Database,
  config: WorkerConfig,
  jobId: string,
  reason: string
): Promise<boolean> {
  const rows = rowsOf<{ status: string }>(
    await db.execute(sql`
      UPDATE jobs SET
        status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'pending'::job_status END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        available_at = NULL,
        last_error = ${reason},
        updated_at = now()
      WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${config.workerId}
      RETURNING status::text AS status
    `)
  )
  return rows[0]?.status === "failed"
}

export interface RequeueOptions {
  /** Earliest next claim: the backoff/Pause delay from now. */
  delayMs: number
  /**
   * `true` for `rate_limited` faults (EC-082: throttling is the provider's
   * signal, not the Job's failure — the attempt this requeue undoes was
   * already refunded by claiming, so give it back).
   */
  refundAttempt: boolean
  /** Recorded in `last_error` for dashboard observability. */
  reason: string
}

/**
 * Requeue a claimed Job with a delay (exponential backoff on
 * 5xx/timeout/invalid-JSON, Retry-After on 429). The Job returns to
 * `pending` and sleeps until `available_at`; the claim gate skips it until
 * then. Guarded to the claiming worker so a lost lease never requeues.
 */
export async function requeueJob(
  db: Database,
  config: WorkerConfig,
  jobId: string,
  options: RequeueOptions
): Promise<void> {
  const availableAt = new Date(
    config.now() + Math.max(0, options.delayMs)
  ).toISOString()
  const attemptUpdate = options.refundAttempt
    ? sql`attempts = GREATEST(attempts - 1, 0),`
    : sql``
  await db.execute(sql`
    UPDATE jobs SET
      status = 'pending',
      ${attemptUpdate}
      lease_owner = NULL,
      lease_expires_at = NULL,
      available_at = ${availableAt},
      last_error = ${options.reason},
      updated_at = now()
    WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${config.workerId}
  `)
}

/**
 * Safety-net Sweeper (spec: a crash between statements can't strand work).
 * Expired-lease Jobs whose attempts are exhausted terminate as Failed; the
 * rest return to `pending` so the claim loop re-runs them. Returns reclaimed
 * job ids.
 */
export async function sweepExpiredJobs(
  db: Database,
  config: WorkerConfig
): Promise<string[]> {
  // ISO string binding (see note above).
  const now = new Date(config.now()).toISOString()
  const failed = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE jobs SET
        status = 'failed',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'lease expired after too many attempts'),
        updated_at = now()
      WHERE status = 'running' AND attempts >= max_attempts AND lease_expires_at < ${now}
      RETURNING id
    `)
  )
  const reclaimed = rowsOf<{ id: string }>(
    await db.execute(sql`
      UPDATE jobs SET
        status = 'pending',
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = now()
      WHERE status = 'running' AND lease_expires_at < ${now}
      RETURNING id
    `)
  )
  return [...failed, ...reclaimed].map((row) => row.id)
}
