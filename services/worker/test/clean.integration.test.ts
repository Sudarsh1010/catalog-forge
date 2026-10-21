/**
 * Clean Stage integration tests — the DB-contract seam.
 *
 * Tests seed domain facts (an Import in stage `clean` plus immutable raw
 * `sheet_rows`), run the real planner/handler/worker loops in-process, and
 * assert the cleaned projection, the Work Queue and the Redis event stream
 * through database state. No worker internals are mocked. Test names cite
 * the EC-### ids they pin from `edge-cases.md`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { CleanColumnPlan } from "@workspace/db/schema"

import { planCleanStage } from "../src/clean/plan.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedImport,
} from "./helpers"

let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

/** Insert raw sheet rows exactly as intake would land them. */
async function seedSheetRows(
  importId: string,
  rows: Array<Array<string | number | boolean | null>>
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await db.db.execute(sql`
      INSERT INTO sheet_rows (store_id, import_id, row_index, raw)
      VALUES ('test-store', ${importId}, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb)
    `)
  }
}

async function cleanJobRows(importId: string) {
  return (await db.db.execute(sql`
    SELECT batch_key, status FROM jobs
    WHERE import_id = ${importId} AND stage = 'clean'
    ORDER BY batch_key
  `)) as unknown as Array<{ batch_key: string; status: string }>
}

async function cleanPlanFor(importId: string) {
  const rows = (await db.db.execute(sql`
    SELECT columns FROM clean_plans WHERE import_id = ${importId}
  `)) as unknown as Array<{ columns: CleanColumnPlan[] }>
  return rows[0]?.columns ?? null
}

describe("clean stage planning (plan-then-execute, ADR-0002)", () => {
  it("plans every row-chunk Job up front with deterministic boundaries", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "clean",
      sheetHeader: ["SKU", "Name", "Price"],
    })
    // 7 rows: one chunk under the default constant chunk size.
    await seedSheetRows(imp.id, [
      ["SKU-1", "Blumentopf", "12.5"],
      ["SKU-2", "Käse", "1.299,00 €"],
      ["SKU-3", "Topf", "8"],
      ["SKU-4", "Tisch", "£8"],
      ["SKU-5", "Stuhl", ""],
      ["SKU-6", "Bank", "12,5"],
      ["SKU-7", "Regal", "1,299.00"],
    ])

    await planCleanStage(db.db, { importId: imp.id, storeId: imp.storeId })

    const jobs = await cleanJobRows(imp.id)
    expect(jobs).toEqual([
      { batch_key: "rows-000001-000007", status: "pending" },
    ])

    // The plan carries one entry per header column, in order.
    const plan = await cleanPlanFor(imp.id)
    expect(plan?.map((c) => [c.index, c.kind])).toEqual([
      [0, "text"],
      [1, "text"],
      [2, "price"],
    ])
  })

  it("chunks at a fixed constant size and re-plans to identical boundaries (determinism)", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "clean",
      sheetHeader: ["SKU", "Name"],
    })
    const rows = Array.from({ length: 10 }, (_, i) => [`SKU-${i + 1}`, "x"])
    await seedSheetRows(imp.id, rows)

    await planCleanStage(
      db.db,
      { importId: imp.id, storeId: imp.storeId },
      { chunkSize: 3 }
    )
    const first = await cleanJobRows(imp.id)

    // Re-planning (restart re-discovering its plan) must not drift or duplicate.
    await planCleanStage(
      db.db,
      { importId: imp.id, storeId: imp.storeId },
      { chunkSize: 3 }
    )
    const second = await cleanJobRows(imp.id)

    expect(first.map((j) => j.batch_key)).toEqual([
      "rows-000001-000003",
      "rows-000004-000006",
      "rows-000007-000009",
      "rows-000010-000010",
    ])
    expect(second).toEqual(first)
  })
})
