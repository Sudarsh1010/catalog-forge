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
import { createCleanHandler } from "../src/clean/handler.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedImport,
  waitFor,
} from "./helpers"
import { createWorker, defineHandlers, resolveConfig } from "../src/index.js"

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

/** Real claim-loop plumbing around the clean handler (no mocks). */
async function runCleanWorker(importId: string): Promise<void> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({ clean: createCleanHandler() }),
    config: resolveConfig({
      workerId: `w-clean-${importId.slice(0, 8)}`,
      claimIntervalMs: 10,
      heartbeatIntervalMs: 50,
      sweepIntervalMs: 25,
      leaseTtlMs: 2_000,
      batchSize: 10,
    }),
  })
  worker.start()
  try {
    await waitFor("clean chunk jobs completed", async () => {
      const rows = (await db.db.execute(sql`
        SELECT count(*)::int AS n FROM jobs
        WHERE import_id = ${importId} AND stage = 'clean' AND status <> 'completed'
      `)) as unknown as Array<{ n: number }>
      return (rows[0]?.n ?? 1) === 0
    })
  } finally {
    await worker.stop()
  }
}

async function cleanedProjection(importId: string) {
  return (await db.db.execute(sql`
    SELECT row_index, values, flags FROM cleaned_rows
    WHERE import_id = ${importId}
    ORDER BY row_index
  `)) as unknown as Array<{
    row_index: number
    values: unknown[]
    flags: unknown[]
  }>
}

describe("clean chunk handler (idempotent upserts, ADR-0003)", () => {
  it("cleans a chunk into the typed projection; re-running the chunk converges with zero duplicates", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "clean",
      sheetHeader: ["SKU", "Name", "Description", "Price"],
    })
    await seedSheetRows(imp.id, [
      [
        "SKU-1",
        "KÃ¤se",
        "<p>Winterfest</p><script>alert(1)</script>",
        "1.299,00 €",
      ],
      ["SKU-2", "GrÃ¶ÃŸe", '=HYPERLINK("http://evil","click")', "12,5"],
    ])
    await planCleanStage(db.db, { importId: imp.id, storeId: imp.storeId })

    await runCleanWorker(imp.id)

    const first = await cleanedProjection(imp.id)
    expect(first).toHaveLength(2)

    const [row1, row2] = first as Array<{
      row_index: number
      values: Array<Record<string, unknown> | null>
      flags: Array<Record<string, unknown>>
    }>

    // EC-002: mojibake repaired where recoverable.
    expect(row1?.values?.[1]).toMatchObject({ kind: "text", value: "Käse" })
    // EC-056: unsafe script stripped, benign markup preserved.
    expect(row1?.values?.[2]).toMatchObject({
      kind: "html",
      value: "<p>Winterfest</p>",
    })
    // EC-021: de price through string math — 1299.00 → 129900 cents.
    expect(row1?.values?.[3]).toMatchObject({
      kind: "price",
      cents: 129900,
      currency: "EUR",
    })

    // EC-022: formula cell neutralized, raw preserved in the flag trail.
    expect(row2?.values?.[2]).toMatchObject({
      kind: "text",
      value: '\'=HYPERLINK("http://evil","click")',
    })
    expect(row2?.values?.[3]).toMatchObject({
      kind: "price",
      cents: 1250,
      currency: "EUR",
    })
    expect(row2?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ ec: "EC-022" })])
    )

    // Idempotency (ADR-0003): redeliver the same Job — the projection must
    // converge byte-identically, never duplicate rows.
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'clean'
    `)
    await runCleanWorker(imp.id)

    const second = await cleanedProjection(imp.id)
    expect(second).toEqual(first)
    const counts = (await db.db.execute(sql`
      SELECT count(*)::int AS n, count(DISTINCT row_index)::int AS distinct_n
      FROM cleaned_rows WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ n: number; distinct_n: number }>
    expect(counts[0]).toEqual({ n: 2, distinct_n: 2 })
  })
})
