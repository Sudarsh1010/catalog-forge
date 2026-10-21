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
import { nextStage, type Stage } from "@workspace/pipeline"

import { rowsOf } from "./jobs"

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
 * the next Stage of the fixed machine (ADR-0002) — `clean` gets planned by
 * the Stage that owns it. Returns the Stage advanced to, or `null` when the
 * Import was already advanced (idempotent re-run after a lost lease).
 */
export async function completeIntake(
  db: Database,
  importId: string,
  header: string[],
  rowCount: number
): Promise<Stage | null> {
  const advancedTo = nextStage("intake")
  if (!advancedTo) return null
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`
    UPDATE imports SET
      stage = ${advancedTo},
      sheet_header = ${JSON.stringify(header)}::jsonb,
      row_count = ${rowCount},
      updated_at = now()
    WHERE id = ${importId} AND status = 'running' AND stage = 'intake'
    RETURNING id
  `)
  )
  return rows.length > 0 ? advancedTo : null
}
