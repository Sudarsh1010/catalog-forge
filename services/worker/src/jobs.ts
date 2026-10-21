/**
 * Job machinery against the Postgres Work Queue (ADR-0001, ADR-0003).
 *
 * All state transitions live here so tests can exercise them directly and the
 * loops stay thin. Claims use `SELECT … FOR UPDATE SKIP LOCKED`, so multiple
 * workers never take the same Job.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { Job } from "@workspace/db/schema"

import type { WorkerConfig } from "./config"

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
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, store_id, import_id, stage, batch_key, attempts, max_attempts
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

/** Mark a Job completed (terminal for this ticket; Row Ledger comes later). */
export async function completeJob(
  db: Database,
  config: WorkerConfig,
  jobId: string
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET
      status = 'completed',
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = now()
    WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${config.workerId}
  `)
}

/**
 * Mark a Job failed. If attempts are exhausted it terminates as `failed`
 * with the reason; otherwise it returns to `pending` for another claim.
 * Attempts are incremented at claim time, so this never bumps the counter.
 */
export async function failJob(
  db: Database,
  config: WorkerConfig,
  jobId: string,
  reason: string
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'pending'::job_status END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = ${reason},
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
