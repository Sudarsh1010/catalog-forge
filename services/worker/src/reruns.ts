/**
 * Re-run adoption — the Worker's side of the Re-run fact (ADR-0004: the app
 * writes a `reruns` row and never touches Job machinery). The Sweeper adopts
 * each request by requeuing, for the fact's stage, the Jobs whose deterministic Batches
 * cover the chosen Products (GLOSSARY: Re-run), resetting attempts like the
 * dashboard retry does, and clearing the request; adoption is idempotent
 * (guarded to terminal Job states, one transaction per fact) and deletes
 * what it adopted, so "fact present" always means "pending adoption".
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"

import { rowsOf } from "./jobs"
import { requeueCoveringProductJobs } from "./requeue"

export interface AdoptedRerun {
  rerunId: string
  importId: string
  stage: string
  requeuedJobIds: string[]
}

/**
 * Batch keys are fixed-width ordinal ranges (`products-000001-000100`,
 * optionally with a `:locale` suffix for translate), so the covering Batch
 * of a chosen Product is its 1-based ordinal in `natural_key_hash` order — the same deterministic order
 * the planner and the enrich handler read (ADR-0002).
 */
export async function adoptReruns(db: Database): Promise<AdoptedRerun[]> {
  const facts = rowsOf<{ id: string }>(
    await db.execute(sql`SELECT id FROM reruns ORDER BY created_at, id`)
  )
  const adopted: AdoptedRerun[] = []
  for (const fact of facts) {
    const handled = await db.transaction(async (tx) => {
      const rows = rowsOf<{
        id: string
        import_id: string
        store_id: string
        stage: string
        product_ids: string[]
      }>(
        await tx.execute(sql`
          SELECT id, import_id, store_id, stage, product_ids
          FROM reruns WHERE id = ${fact.id} FOR UPDATE
        `)
      )
      const rerun = rows[0]
      if (!rerun) return null // a concurrent sweep already adopted it
      if (rerun.product_ids.length === 0) {
        // Nothing chosen — adopt by clearing the fact; no Job is affected.
        await tx.execute(sql`DELETE FROM reruns WHERE id = ${rerun.id}`)
        return {
          rerunId: rerun.id,
          importId: rerun.import_id,
          stage: rerun.stage,
          requeuedJobIds: [],
        } satisfies AdoptedRerun
      }
      // A Product lands in exactly one Batch; the shared helper requeues
      // only terminal Jobs (completed = the enrichment being redone,
      // failed = poison) whose Batch covers a chosen Product. Pending/
      // running Jobs will run anyway — requeuing them is a no-op.
      const requeuedJobIds = await requeueCoveringProductJobs(
        tx,
        rerun.import_id,
        rerun.stage,
        rerun.product_ids
      )
      await tx.execute(sql`DELETE FROM reruns WHERE id = ${rerun.id}`)
      return {
        rerunId: rerun.id,
        importId: rerun.import_id,
        stage: rerun.stage,
        requeuedJobIds,
      } satisfies AdoptedRerun
    })
    if (handled) adopted.push(handled)
  }
  return adopted
}
