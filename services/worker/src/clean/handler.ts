/**
 * The `clean` Stage handler: one Job cleans one deterministic row chunk
 * (GLOSSARY: Batch) into the typed cleaned projection.
 *
 * Idempotent by construction (ADR-0003): results upsert on row identity
 * (import, row_index), so a redelivered Job converges — zero duplicates.
 * Stage advancement does not happen here: the Job machinery advances the
 * Import inside the completion transaction when the last chunk finishes.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { CleanColumnPlan } from "@workspace/db/schema"
import {
  cleanPlans,
  cleanedRows,
  imports,
  sheetRows,
} from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import { cleanRow, type RowCleanResult } from "./cells"
import type { JobContext, JobHandler } from "../handlers"
import { parseBatchKey } from "./plan"

const log = createLogger({ service: "worker:clean" })

/** Rows upserted per statement — bounded, like intake's row landing. */
const UPSERT_BATCH = 200

interface CleanedRowUpsert {
  rowIndex: number
  values: RowCleanResult["values"]
  flags: RowCleanResult["flags"]
}

export function createCleanHandler(): JobHandler {
  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx
    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `clean: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op

    const columns = await loadColumns(db, job.importId)
    const range = parseBatchKey(job.batchKey)
    if (!range) {
      // A batch key the planner could not have written — poison, not retry.
      throw new Error(`clean: unparseable batch key "${job.batchKey}"`)
    }

    const rows = await db
      .select({ rowIndex: sheetRows.rowIndex, raw: sheetRows.raw })
      .from(sheetRows)
      .where(
        and(
          eq(sheetRows.importId, job.importId),
          gte(sheetRows.rowIndex, range.start),
          lte(sheetRows.rowIndex, range.end)
        )
      )
      .orderBy(asc(sheetRows.rowIndex))

    let upserted = 0
    for (let index = 0; index < rows.length; index += UPSERT_BATCH) {
      const batch: CleanedRowUpsert[] = rows
        .slice(index, index + UPSERT_BATCH)
        .map((row) => ({
          rowIndex: row.rowIndex,
          ...cleanRow(row.raw, columns),
        }))
      await upsertCleaned(db, job.storeId, job.importId, batch)
      upserted += batch.length
    }

    log.info(`clean chunk completed`, {
      importId: job.importId,
      jobId: job.id,
      batchKey: job.batchKey,
      rows: upserted,
    })
  }
}

async function loadImport(
  db: Database,
  importId: string
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: imports.id, status: imports.status })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)
  return rows[0] ?? null
}

async function loadColumns(
  db: Database,
  importId: string
): Promise<CleanColumnPlan[]> {
  const rows = await db
    .select({ columns: cleanPlans.columns })
    .from(cleanPlans)
    .where(eq(cleanPlans.importId, importId))
    .limit(1)
  const columns = rows[0]?.columns
  if (!columns) {
    // The planner inserts these in the same transaction that advances the
    // stage, so a missing plan means the contract was violated — retryable.
    throw new Error(`clean: no clean plan for import ${importId}`)
  }
  return columns
}

/** Idempotent landing: upsert on (import, row_index), never append. */
async function upsertCleaned(
  db: Database,
  storeId: string,
  importId: string,
  rows: CleanedRowUpsert[]
): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(cleanedRows)
    .values(
      rows.map((row) => ({
        storeId,
        importId,
        rowIndex: row.rowIndex,
        values: row.values,
        flags: row.flags,
      }))
    )
    .onConflictDoUpdate({
      target: [cleanedRows.importId, cleanedRows.rowIndex],
      set: {
        values: sql`EXCLUDED.${sql.identifier("values")}`,
        flags: sql`EXCLUDED.${sql.identifier("flags")}`,
        updatedAt: new Date(),
      },
    })
}
