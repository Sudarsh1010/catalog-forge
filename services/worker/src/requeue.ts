/**
 * Shared terminal-Job requeue (ADR-0002 Batch identity): the one `UPDATE
 * jobs` used by every adoption path that requeues the Jobs whose
 * deterministic Batches cover chosen Products — the Sweeper adopting
 * Re-run facts (ADR-0004) and the group handler's Out-of-Date barrier.
 *
 * The Batch filter matches BOTH key shapes — plain enrich keys
 * (`products-000001-000100`) and translate keys with their locale suffix
 * (`products-000001-000100:de`) — via the exported prefix pattern; the
 * ordinal containment reads the ranges out of the fully-anchored pattern,
 * which captures the same start/end groups for both shapes. Only terminal
 * Jobs (completed = the work being redone, failed = poison) are requeued;
 * pending/running Jobs run anyway.
 */
import { sql, type SQL } from "drizzle-orm"

import {
  PRODUCT_BATCH_KEY_PATTERN,
  PRODUCT_BATCH_KEY_PREFIX_PATTERN,
} from "@workspace/pipeline"

import { rowsOf } from "./jobs"

/** Anything with Drizzle's `execute` — a Database or a transaction. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>
}

/**
 * Requeue (status pending, attempts reset) every terminal Job of `importId`
 * on `stage` whose Batch key's ordinal range covers any of `productIds`'
 * 1-based positions in the Import's `natural_key_hash` order — the same
 * deterministic order the planner and the handlers read. Returns the
 * requeued Job ids for logging.
 */
export async function requeueCoveringProductJobs(
  tx: SqlExecutor,
  importId: string,
  stage: string,
  productIds: string[]
): Promise<string[]> {
  const requeued = rowsOf<{ id: string }>(
    await tx.execute(sql`
      UPDATE jobs SET
        status = 'pending',
        attempts = 0,
        lease_owner = NULL,
        lease_expires_at = NULL,
        available_at = NULL,
        updated_at = now()
      WHERE import_id = ${importId}
        AND stage = ${stage}
        AND status IN ('completed', 'failed')
        AND batch_key ~ ${PRODUCT_BATCH_KEY_PREFIX_PATTERN}
        AND EXISTS (
          SELECT 1 FROM (
            SELECT ROW_NUMBER() OVER (ORDER BY p.natural_key_hash) AS ordinal
            FROM products p
            WHERE p.import_id = ${importId}
              AND p.id IN (${sql.join(
                productIds.map((id) => sql`${id}::uuid`),
                sql`, `
              )})
          ) picked
          WHERE picked.ordinal
            BETWEEN (regexp_match(
                      jobs.batch_key, ${PRODUCT_BATCH_KEY_PATTERN}
                    ))[1]::int
                AND (regexp_match(
                      jobs.batch_key, ${PRODUCT_BATCH_KEY_PATTERN}
                    ))[2]::int
        )
      RETURNING id
    `)
  )
  return requeued.map((row) => row.id)
}
