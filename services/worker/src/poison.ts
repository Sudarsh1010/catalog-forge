/**
 * The poison path (ADR-0003): a Job that exhausted its attempts terminates
 * as Failed-with-reason, and the rows its Batch covers carry that reason in
 * the Row Ledger — merchant-fixable and retryable (EC-122: one poisoned
 * item quarantined, the Import keeps moving; EC-126: nothing silently
 * missing).
 *
 * Scope is stage knowledge: only enrich/translate Jobs cover a product
 * Batch, so `failBatchRows` maps the deterministic Batch key back to the
 * exact Sheet Rows the handler would have processed. A successful retry
 * heals its rows back to their durable terminal state (`healBatchRows`) —
 * failed is a quarantine, never a verdict about data that later landed.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"

import { parseProductBatchKey } from "./media/plan"

/** The failed Job, as the poison writer sees it. */
export interface PoisonedJob {
  storeId: string
  importId: string
  stage: string
  batchKey: string
  attempts: number
}

/**
 * What one terminally-failed Job means for the domain, per Stage — only the
 * Stage knows which Sheet Rows its Batch covers. Registered on the Worker
 * (`main.ts` wires the Row Ledger writer for enrich/translate). Returns are
 * the handler's business (row counts for tests/logs); the Worker ignores
 * them.
 */
export type PoisonHandler = (
  db: Database,
  job: PoisonedJob,
  reason: string
) => Promise<unknown>

/** Static, string-keyed lookup: stages whose Jobs cover a product Batch. */
const IS_BATCH_STAGE: Record<string, true> = {
  enrich: true,
  translate: true,
}

/**
 * Record a terminally-failed Job's rows as Failed-with-reason in the Row
 * Ledger. Rows already terminal through a previous success are left alone
 * (at-least-once convergence, ADR-0003); ungrouped rows (no Product) belong
 * to no Batch and stay with finalise's reconciliation. Returns the number
 * of rows quarantined.
 */
export async function failBatchRows(
  db: Database,
  job: PoisonedJob,
  reason: string
): Promise<number> {
  const range = parseProductBatchKey(job.batchKey)
  if (!range) return 0
  const failureReason =
    `The ${job.stage} stage failed ${job.attempts}× for this row's product ` +
    `batch and gave up (poison): ${reason} Retry from the dashboard to ` +
    `reprocess it (EC-122).`
  const result = (await db.execute(sql`
    WITH batch AS (
      SELECT id FROM products
      WHERE import_id = ${job.importId}
      ORDER BY natural_key_hash
      OFFSET ${range.start - 1} LIMIT ${range.end - range.start + 1}
    )
    UPDATE row_ledger SET
      state = 'failed',
      failure_reason = ${failureReason},
      updated_at = now()
    WHERE import_id = ${job.importId}
      AND product_id IN (SELECT id FROM batch)
      AND state <> 'failed'
    RETURNING row_index
  `)) as unknown as Array<{ row_index: number }>
  return result.length
}

/**
 * Heal a Batch's quarantined rows after a successful (re)run: each row
 * returns to its durable terminal state — Needs Review when the Product or
 * its enrichment is gated, Done otherwise. Rows whose Product never
 * enriched stay Failed: healing may not lie about work that never happened.
 */
export async function healBatchRows(
  db: Database,
  importId: string,
  batchKey: string
): Promise<number> {
  const range = parseProductBatchKey(batchKey)
  if (!range) return 0
  const result = (await db.execute(sql`
    WITH batch AS (
      SELECT id FROM products
      WHERE import_id = ${importId}
      ORDER BY natural_key_hash
      OFFSET ${range.start - 1} LIMIT ${range.end - range.start + 1}
    )
    UPDATE row_ledger rl SET
      state = CASE
        WHEN p.needs_review OR COALESCE(e.status, 'ready') = 'needs_review'
          THEN 'needs_review'
        ELSE 'done'
      END::row_ledger_state,
      updated_at = now()
    FROM batch b
    JOIN products p ON p.id = b.id
    LEFT JOIN product_enrichments e ON e.product_id = p.id
    WHERE rl.product_id = p.id AND rl.state = 'failed'
      AND EXISTS (
        SELECT 1 FROM product_enrichments pe WHERE pe.product_id = p.id
      )
    RETURNING rl.row_index
  `)) as unknown as Array<{ row_index: number }>
  return result.length
}

/** True when the stage's Jobs cover a product Batch (the poison writers). */
export function isBatchStage(stage: string): boolean {
  return IS_BATCH_STAGE[stage] === true
}
