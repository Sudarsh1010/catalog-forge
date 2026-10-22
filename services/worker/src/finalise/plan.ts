/**
 * The finalise Stage's planner (ADR-0002 plan-then-execute): ONE Job per
 * Import (GLOSSARY: Barrier Stage — finalise observes the whole Import's
 * ledger). Runs inside the completion transaction that flips the Import
 * from `translate` to `finalise`; conflict-nothing on the (Import, Stage,
 * Batch) identity.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"

import type { StagePlanTarget } from "../stages"

/** The single deterministic Batch identity of the finalise barrier. */
export const FINALISE_BATCH_KEY = "finalise"

export async function planFinaliseStage(
  db: Database,
  target: StagePlanTarget
): Promise<void> {
  await db.execute(sql`
    INSERT INTO jobs (store_id, import_id, stage, batch_key)
    VALUES (${target.storeId}, ${target.importId}, 'finalise', ${FINALISE_BATCH_KEY})
    ON CONFLICT (import_id, stage, batch_key) DO NOTHING
  `)
}
