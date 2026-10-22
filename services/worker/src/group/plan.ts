/**
 * The group Stage's planner (ADR-0002 plan-then-execute): the Barrier Stage
 * is ONE Job per Import observing ALL cleaned rows (GLOSSARY: Barrier
 * Stage). Runs inside the completion transaction that flips the Import from
 * `clean` to `group`, so the barrier exists the moment the stage value does.
 * Re-planning is conflict-nothing on the (Import, Stage, Batch) identity.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"

import type { StagePlanTarget } from "../stages"

/** The single deterministic Batch identity of the barrier. */
export const GROUP_BATCH_KEY = "barrier"

export async function planGroupStage(
  db: Database,
  target: StagePlanTarget
): Promise<void> {
  await db.execute(sql`
    INSERT INTO jobs (store_id, import_id, stage, batch_key)
    VALUES (${target.storeId}, ${target.importId}, 'group', ${GROUP_BATCH_KEY})
    ON CONFLICT (import_id, stage, batch_key) DO NOTHING
  `)
}
