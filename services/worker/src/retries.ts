/**
 * Dashboard retry adoption — the Worker's side of the retry fact (ADR-0004:
 * the app writes a `job_retries` row and never touches Job machinery). The
 * Sweeper adopts each request by requeuing the poison Job with reset
 * attempts and clearing the request; adoption is idempotent (guarded to
 * `status = 'failed'`, one request per Job by unique index) and deletes
 * what it adopted, so "request present" always means "pending adoption".
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"

import { rowsOf } from "./jobs"

export interface AdoptedRetry {
  jobId: string
  importId: string
}

/**
 * Requeue every Failed Job with an adopted retry request: `attempts` back
 * to zero (a fresh lease on life — the five-strike count was the previous
 * run's), any backoff/Pause schedule cleared, `last_error` kept for the
 * audit trail until the next claim overwrites it.
 */
export async function adoptJobRetries(db: Database): Promise<AdoptedRetry[]> {
  return db.transaction(async (tx) => {
    const requeued = rowsOf<{ id: string; import_id: string }>(
      await tx.execute(sql`
        UPDATE jobs SET
          status = 'pending',
          attempts = 0,
          lease_owner = NULL,
          lease_expires_at = NULL,
          available_at = NULL,
          updated_at = now()
        WHERE id IN (SELECT job_id FROM job_retries) AND status = 'failed'
        RETURNING id, import_id
      `)
    )
    if (requeued.length > 0) {
      await tx.execute(sql`
        DELETE FROM job_retries
        WHERE job_id IN (${sql.join(
          requeued.map((row) => sql`${row.id}::uuid`),
          sql`, `
        )})
      `)
    }
    return requeued.map((row) => ({ jobId: row.id, importId: row.import_id }))
  })
}
