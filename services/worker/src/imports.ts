/**
 * Worker-side Import machinery: Sweeper adoption, terminal failure, and the
 * intake completion transition. The web app wrote the facts (ADR-0004); the
 * worker owns everything downstream of `status = 'queued'`.
 *
 * All transitions are guarded single statements, so at-least-once execution
 * (ADR-0003) converges instead of duplicating.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import { isStage, nextStage, type Stage } from "@workspace/pipeline"

import { rowsOf } from "./jobs"
import type { StagePlanner, StagePlannerRegistry } from "./stages"

/** The stage this repair-shape plans for (the clean planner's registry key). */
const CLEAN_STAGE = "clean"

/**
 * Sweeper adoption: every `queued` Import becomes `running` with its intake
 * Job planned — in one transaction, so a crash between the two statements
 * can't strand an Import mid-adoption (the stage-advance sweeper would
 * otherwise see "running, zero jobs" and misread it as ready to advance).
 *
 * Returns the number of Imports adopted. Safe to run on every sweep tick:
 * the status guard makes re-adoption a no-op, and the Job's batch identity
 * constraint backs that up at the storage layer.
 */
export async function adoptQueuedImports(db: Database): Promise<number> {
  let adopted = 0
  await db.transaction(async (tx) => {
    const rows = rowsOf<{ id: string; store_id: string }>(
      await tx.execute(sql`
      UPDATE imports SET status = 'running', updated_at = now()
      WHERE id IN (
        SELECT id FROM imports WHERE status = 'queued' ORDER BY created_at, id LIMIT 100
      )
      RETURNING id, store_id
    `)
    )
    for (const row of rows) {
      await tx.execute(sql`
        INSERT INTO jobs (store_id, import_id, stage, batch_key)
        VALUES (${row.store_id}, ${row.id}, 'intake', 'intake')
        ON CONFLICT DO NOTHING
      `)
    }
    adopted = rows.length
  })
  return adopted
}

/**
 * Mark an Import terminally Failed with a merchant-fixable reason. Guarded
 * to pre-terminal statuses so a retry racing a failure can't resurrect it.
 */
export async function failImport(
  db: Database,
  importId: string,
  reason: string
): Promise<void> {
  await db.execute(sql`
    UPDATE imports SET
      status = 'failed',
      failure_reason = ${reason},
      updated_at = now()
    WHERE id = ${importId} AND status IN ('queued', 'running')
  `)
}

/**
 * Intake completion: land the header and row count and advance the Import to
 * the next Stage of the fixed machine (ADR-0002). The next Stage's planner
 * (when registered) runs in the SAME transaction — a crash can never leave
 * the Import advanced but unplanned. Returns the Stage advanced to, or
 * `null` when the Import was already advanced (idempotent re-run after a
 * lost lease).
 */
export async function completeIntake(
  db: Database,
  importId: string,
  header: string[],
  rowCount: number,
  planNextStage?: StagePlanner
): Promise<Stage | null> {
  const advancedTo = nextStage("intake")
  if (!advancedTo) return null
  return db.transaction(async (tx) => {
    const rows = rowsOf<{ id: string; store_id: string }>(
      await tx.execute(sql`
      UPDATE imports SET
        stage = ${advancedTo},
        sheet_header = ${JSON.stringify(header)}::jsonb,
        row_count = ${rowCount},
        updated_at = now()
      WHERE id = ${importId} AND status = 'running' AND stage = 'intake'
      RETURNING id, store_id
    `)
    )
    if (rows.length === 0) return null
    if (planNextStage) {
      await planNextStage(tx, {
        importId,
        storeId: rows[0]!.store_id,
      })
    }
    return advancedTo
  })
}

/**
 * Safety-net Sweeper (spec: a crash between statements can't strand an
 * Import mid-Stage). Two repairs, both idempotent guards so racing the
 * decentralized advance (completeJob) converges:
 *
 *   1. An Import whose current Stage has at least one Job and zero
 *      pending/running Jobs but has not advanced — the "last job lost the
 *      race after completing" shape — advances and plans the next Stage.
 *      Terminally Failed Jobs do not block: the Row Ledger records them as
 *      Failed-with-reason and the dashboard offers retry.
 *   2. A clean-Stage Import with rows but zero clean Jobs gets its Jobs
 *      planned (crash-shape protection for the planner seam).
 *   3. An Import sitting in `enrich` or `translate` with ZERO Jobs of that
 *      Stage — the legitimate empty-Batch shape (nothing grouped, nothing
 *      to enrich or translate) — advances; planning happens on entry.
 *
 * Only stages with a registered next-planner get planning; the stage value
 * always advances. Terminally-failed INTAKE work never advances (zero
 * completed jobs), so a poisoned intake waits for dashboard retry instead
 * of cleaning a sheet that never landed.
 */
export async function sweepStalledStageAdvances(
  db: Database,
  planners?: StagePlannerRegistry
): Promise<Array<{ importId: string; from: Stage; to: Stage }>> {
  const stalled = rowsOf<{ id: string; store_id: string; stage: string }>(
    await db.execute(sql`
      SELECT i.id, i.store_id, i.stage FROM imports i
      WHERE i.status = 'running' AND (
        (
          i.stage IN ('intake', 'clean', 'group', 'match-media', 'enrich', 'translate')
          AND EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.import_id = i.id AND j.stage = i.stage AND j.status = 'completed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.import_id = i.id AND j.stage = i.stage
              AND j.status IN ('pending', 'running')
          )
        ) OR (
          i.stage IN ('enrich', 'translate')
          AND NOT EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.import_id = i.id AND j.stage = i.stage
          )
        )
      )
    `)
  )
  const advanced: Array<{ importId: string; from: Stage; to: Stage }> = []
  for (const row of stalled) {
    if (!isStage(row.stage)) continue
    const next = nextStage(row.stage)
    if (!next) continue
    const flipped = rowsOf<{ id: string }>(
      await db.execute(sql`
        UPDATE imports SET stage = ${next}, updated_at = now()
        WHERE id = ${row.id} AND status = 'running' AND stage = ${row.stage}
        RETURNING id
      `)
    )
    if (flipped.length === 0) continue
    const planner = planners?.[next]
    if (planner) {
      await planner(db, { importId: row.id, storeId: row.store_id })
    }
    advanced.push({ importId: row.id, from: row.stage, to: next })
  }

  // Repair shape 2: clean planned nothing (crash before the planner seam
  // existed, or a manual fix) — plan now, the claim loop takes it from there.
  const unplanned = rowsOf<{ id: string; store_id: string }>(
    await db.execute(sql`
      SELECT i.id, i.store_id FROM imports i
      WHERE i.status = 'running' AND i.stage = 'clean'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.import_id = i.id AND j.stage = 'clean')
        AND EXISTS (SELECT 1 FROM sheet_rows r WHERE r.import_id = i.id)
    `)
  )
  for (const row of unplanned) {
    const planner = planners?.[CLEAN_STAGE]
    if (!planner) break
    await planner(db, { importId: row.id, storeId: row.store_id })
  }
  return advanced
}
