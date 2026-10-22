/**
 * Group Barrier Stage integration tests — the DB-contract seam.
 *
 * Tests seed domain facts (an Import, immutable raw `sheet_rows`, real clean
 * output), run the real planner/handler/worker loops in-process, and assert
 * Products, Variants, the Row Ledger and the Work Queue through Postgres
 * state. No worker internals are mocked. Test names cite the EC-### ids they
 * pin from `edge-cases.md`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"

import { planCleanStage } from "../src/clean/plan.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { GROUP_BATCH_KEY, planGroupStage } from "../src/group/plan.js"
import {
  enrichBatchKey,
  parseProductBatchKey,
  planMatchMediaStage,
  translateBatchKey,
} from "../src/media/plan.js"
import { createWorker, defineHandlers } from "../src/index.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedImport,
  waitFor,
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

type Cell = string | number | boolean | null

/** Insert raw sheet rows exactly as intake would land them. */
async function seedSheetRows(importId: string, rows: Cell[][]): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await db.db.execute(sql`
      INSERT INTO sheet_rows (store_id, import_id, row_index, raw)
      VALUES ('test-store', ${importId}, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb)
    `)
  }
}

/** Run the real clean Stage until every chunk Job finished. */
async function runCleanWorker(importId: string): Promise<void> {
  const stop = await startWorker(
    { clean: createCleanHandler() },
    { clean: planCleanStage }
  )
  try {
    await waitFor("clean jobs completed", async () => {
      const rows = (await db.db.execute(sql`
        SELECT count(*)::int AS n FROM jobs
        WHERE import_id = ${importId} AND stage = 'clean' AND status <> 'completed'
      `)) as unknown as Array<{ n: number }>
      return (rows[0]?.n ?? 1) === 0
    })
  } finally {
    await stop()
  }
}

/**
 * Seed an Import, clean its rows for real, and leave it at stage `group`
 * with NO barrier planned — the pre-Ticket-4 seam, under each test's control.
 */
async function prepareCleanedImport(
  header: string[],
  rows: Cell[][],
  contentHash?: string
): Promise<{ id: string; storeId: string }> {
  const imp = await seedImport(db, {
    status: "running",
    stage: "clean",
    sheetHeader: header,
    contentHash,
  })
  await seedSheetRows(imp.id, rows)
  await planCleanStage(db.db, { importId: imp.id, storeId: imp.storeId })
  await runCleanWorker(imp.id)
  return imp
}

/** Plan the barrier and run the real group handler until the Job completed. */
async function runGroupBarrier(imp: {
  id: string
  storeId: string
}): Promise<void> {
  await planGroupStage(db.db, { importId: imp.id, storeId: imp.storeId })
  const stop = await startWorker(
    { clean: createCleanHandler(), group: createGroupHandler() },
    { clean: planCleanStage, group: planGroupStage }
  )
  try {
    await waitFor("group barrier job completed", async () => {
      const rows = (await db.db.execute(sql`
        SELECT status FROM jobs
        WHERE import_id = ${imp.id} AND stage = 'group'
      `)) as unknown as Array<{ status: string }>
      return rows.length === 1 && rows[0]!.status === "completed"
    })
  } finally {
    await stop()
  }
}

/** Like {@link runGroupBarrier} but with the media planner wired at barrier
 * completion — the real fan-out seam under test. */
async function runGroupBarrierFanningOut(imp: {
  id: string
  storeId: string
}): Promise<void> {
  await planGroupStage(db.db, { importId: imp.id, storeId: imp.storeId })
  const stop = await startWorker(
    { clean: createCleanHandler(), group: createGroupHandler() },
    {
      clean: planCleanStage,
      group: planGroupStage,
      "match-media": planMatchMediaStage,
    }
  )
  try {
    await waitFor("group barrier job completed", async () => {
      const rows = (await db.db.execute(sql`
        SELECT status FROM jobs
        WHERE import_id = ${imp.id} AND stage = 'group'
      `)) as unknown as Array<{ status: string }>
      return rows.length === 1 && rows[0]!.status === "completed"
    })
  } finally {
    await stop()
  }
}

/** Start real worker loops with the given handlers/planners; returns stop(). */
function startWorker(
  handlers: Parameters<typeof defineHandlers>[0],
  planners: Record<
    string,
    (
      db: Db["db"],
      target: { importId: string; storeId: string }
    ) => Promise<void>
  >
) {
  const worker = createWorker({
    db,
    handlers: defineHandlers(handlers as never),
    config: {
      workerId: `w-group-${crypto.randomUUID().slice(0, 8)}`,
      claimIntervalMs: 10,
      heartbeatIntervalMs: 50,
      sweepIntervalMs: 25,
      leaseTtlMs: 2_000,
      batchSize: 10,
    },
    planners,
  })
  worker.start()
  return worker.stop.bind(worker)
}

interface ProductRow {
  id: string
  natural_key: string
  identity_kind: string
  title: string
  brand: string | null
  gtin: string | null
  needs_review: boolean
  review_reason: string | null
}

async function productRows(importId: string): Promise<ProductRow[]> {
  return (await db.db.execute(sql`
    SELECT id, natural_key, identity_kind, title, brand, gtin,
           needs_review, review_reason
    FROM products WHERE import_id = ${importId}
    ORDER BY natural_key
  `)) as unknown as ProductRow[]
}

interface VariantRow {
  sku: string | null
  variant_key: string
  price_cents: number | null
  price_currency: string | null
  attributes: Record<string, string>
  needs_review: boolean
  review_reason: string | null
}

async function variantRows(importId: string): Promise<VariantRow[]> {
  return (await db.db.execute(sql`
    SELECT v.sku, v.variant_key, v.price_cents, v.price_currency,
           v.attributes, v.needs_review, v.review_reason
    FROM variants v WHERE v.import_id = ${importId}
    ORDER BY v.variant_key
  `)) as unknown as VariantRow[]
}

interface LedgerRow {
  row_index: number
  state: string
  product_id: string | null
  variant_id: string | null
  failure_ec: string | null
  failure_reason: string | null
}

async function ledgerRows(importId: string): Promise<LedgerRow[]> {
  return (await db.db.execute(sql`
    SELECT row_index, state, product_id, variant_id, failure_ec, failure_reason
    FROM row_ledger WHERE import_id = ${importId}
    ORDER BY row_index
  `)) as unknown as LedgerRow[]
}

describe("group stage planning (plan-then-execute, ADR-0002)", () => {
  it("plans exactly one barrier Job and re-plans to the identical single Job", async () => {
    const imp = await prepareCleanedImport(
      ["SKU", "Title", "Price"],
      [["TP-100", "Gießkanne", "12,50"]]
    )
    await planGroupStage(db.db, { importId: imp.id, storeId: imp.storeId })
    await planGroupStage(db.db, { importId: imp.id, storeId: imp.storeId })

    const jobs = (await db.db.execute(sql`
      SELECT batch_key, status FROM jobs
      WHERE import_id = ${imp.id} AND stage = 'group'
    `)) as unknown as Array<{ batch_key: string; status: string }>
    expect(jobs).toEqual([{ batch_key: GROUP_BATCH_KEY, status: "pending" }])
  })
})

describe("grouping into Products and Variants", () => {
  it("groups variant SKUs under one Product while an unrelated SKU stays separate (EC-033), merging near-duplicate rows richer-copy-wins (EC-061)", async () => {
    const imp = await prepareCleanedImport(
      ["SKU", "Title", "Price", "Farbe"],
      [
        ["TP-100-R", "Gießkanne 5L", "12,50", "rot"],
        ["tp-100-r", "Gießkanne 5l", "12,50", "rot"], // near-duplicate, case-folded
        ["TP-100-G", "Gießkanne 5L", "", "grün"], // blank price yields to the filled copy
        ["TP-101", "Schaufel", "4,90", ""],
      ]
    )
    await runGroupBarrier(imp)

    const products = await productRows(imp.id)
    expect(products.map((p) => p.natural_key)).toEqual([
      "sku:tp-100",
      "sku:tp-101",
    ])
    expect(products.map((p) => p.identity_kind)).toEqual(["code", "code"])
    expect(products.map((p) => p.title)).toEqual(["Gießkanne 5L", "Schaufel"])

    const variants = await variantRows(imp.id)
    expect(variants.map((v) => v.variant_key)).toEqual([
      "sku:tp-100-g",
      "sku:tp-100-r",
      "sku:tp-101",
    ])
    const red = variants.find((v) => v.variant_key === "sku:tp-100-r")
    expect(red?.price_cents).toBe(1250)
    expect(red?.attributes).toEqual({ Farbe: "rot" })
    const green = variants.find((v) => v.variant_key === "sku:tp-100-g")
    expect(green?.price_cents).toBeNull() // blank yields, no conflict
    expect(green?.attributes).toEqual({ Farbe: "grün" })

    // Every row landed Done; the duplicate rows both point at the same Product.
    const ledger = await ledgerRows(imp.id)
    expect(ledger).toHaveLength(4)
    expect(new Set(ledger.map((l) => l.state))).toEqual(new Set(["done"]))
  })

  it("collapses NFC, invisible-character and case variants of a supplier code into one Product (EC-034, EC-035) and flags conflicting duplicate prices for review (EC-061)", async () => {
    const nbspHyphen = "ABC\u2011001" // U+2011 non-breaking hyphen
    const imp = await prepareCleanedImport(
      ["SKU", "Title", "Price"],
      [
        ["ABC-001", "Regal", "50,00"],
        [nbspHyphen, "Regal", "60,00"], // invisible hyphen variant — same identity
        ["  ABC\u00a0\u2011001\u200b", "Regal", ""], // NBSP, trailing space, zero-width space
        ["abc-001", "Regal", ""], // EC-035: case-folded onto the same key
      ]
    )
    await runGroupBarrier(imp)

    const products = await productRows(imp.id)
    expect(products).toHaveLength(1)
    expect(products[0]!.natural_key).toBe("sku:abc-001")

    const variants = await variantRows(imp.id)
    expect(variants).toHaveLength(1)
    // EC-061: two different prices on one variant key → review, both values shown.
    expect(variants[0]!.needs_review).toBe(true)
    expect(variants[0]!.price_cents).toBe(5000)
    expect(variants[0]!.review_reason).toContain("5000")
    expect(variants[0]!.review_reason).toContain("6000")
    // Needs Review mirrors into the Product and the Row Ledger.
    expect(products[0]!.needs_review).toBe(true)
    const ledger = await ledgerRows(imp.id)
    expect(ledger.map((l) => l.state)).toEqual([
      "needs_review",
      "needs_review",
      "needs_review",
      "needs_review",
    ])
  })

  it("scopes Natural Keys per source sheet so the same supplier code stays two Products (EC-032)", async () => {
    const header = ["SKU", "Title", "Price"]
    const rows: Cell[][] = [["TP-100", "Gießkanne", "12,50"]]
    const first = await prepareCleanedImport(header, rows, "hash-src-a")
    const second = await prepareCleanedImport(header, rows, "hash-src-b")
    await runGroupBarrier(first)
    await runGroupBarrier(second)

    const all = (await db.db.execute(sql`
      SELECT import_id, natural_key FROM products
      WHERE natural_key = 'sku:tp-100'
        AND import_id IN (${first.id}, ${second.id})
      ORDER BY import_id
    `)) as unknown as Array<{ import_id: string; natural_key: string }>
    expect(all).toHaveLength(2)
    expect(new Set(all.map((p) => p.import_id))).toEqual(
      new Set([first.id, second.id])
    )
    // And each Import still sees exactly one Product of its own.
    expect(await productRows(first.id)).toHaveLength(1)
    expect(await productRows(second.id)).toHaveLength(1)
  })
})

describe("Row Ledger accounting", () => {
  it("lands every Sheet Row in the ledger: grouped rows Done, title-fallback rows Needs Review (EC-031), ungroupable rows Failed with a reason — counts add up", async () => {
    const imp = await prepareCleanedImport(
      ["SKU", "Title", "Price"],
      [
        ["TP-100", "Gießkanne", "12,50"],
        ["", "Nur Titel ohne Code", ""], // no SKU: title fallback identity (EC-031)
        ["", "", "9,99"], // no identity at all → Failed (EC-031)
      ]
    )
    // Simulate a clean chunk that died for row 4: raw row exists, projection gone.
    await db.db.execute(sql`
      INSERT INTO sheet_rows (store_id, import_id, row_index, raw)
      VALUES ('test-store', ${imp.id}, 4, '["XX","Kein Clean","1"]'::jsonb)
    `)
    await db.db.execute(sql`
      DELETE FROM cleaned_rows WHERE import_id = ${imp.id} AND row_index = 4
    `)

    await runGroupBarrier(imp)

    const ledger = await ledgerRows(imp.id)
    expect(ledger).toHaveLength(4)
    expect(ledger[0]).toMatchObject({ state: "done" })
    expect(ledger[1]).toMatchObject({ state: "needs_review" })
    expect(ledger[2]).toMatchObject({ state: "failed", failure_ec: "EC-031" })
    expect(ledger[2]!.failure_reason).toMatch(/identity/i)
    expect(ledger[3]).toMatchObject({ state: "failed" })
    expect(ledger[3]!.failure_reason).toMatch(/clean/i)

    // The counts add up to the sheet: one ledger row per sheet_rows row,
    // every state terminal, grouped rows linked to their Product.
    const counts = (await db.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM sheet_rows WHERE import_id = ${imp.id}) AS sheet,
        (SELECT count(*)::int FROM row_ledger WHERE import_id = ${imp.id}) AS ledger,
        (SELECT count(*)::int FROM row_ledger
          WHERE import_id = ${imp.id} AND state <> 'failed' AND product_id IS NULL) AS broken
    `)) as unknown as Array<{ sheet: number; ledger: number; broken: number }>
    expect(counts[0]).toEqual({ sheet: 4, ledger: 4, broken: 0 })

    // Title-fallback identity is flagged low-confidence on the Product too.
    const products = await productRows(imp.id)
    const titled = products.find((p) => p.identity_kind === "title")
    expect(titled?.needs_review).toBe(true)
    expect(titled?.natural_key).toContain("title:")
  })
})

describe("barrier fan-out (deterministic Batch boundaries)", () => {
  it("plans match-media plus enrich/translate product batches when the barrier completes, and re-planning converges (ADR-0002)", async () => {
    const imp = await prepareCleanedImport(
      ["SKU", "Title", "Price"],
      [
        ["TP-100", "Gießkanne", "12,50"],
        ["TP-101", "Schaufel", "4,90"],
        ["TP-102", "Rechen", "7,00"],
      ]
    )
    await runGroupBarrierFanningOut(imp)

    // Barrier completion flipped the stage; the next Stage's Batches exist.
    const importRow = (await db.db.execute(sql`
      SELECT stage FROM imports WHERE id = ${imp.id}
    `)) as unknown as Array<{ stage: string }>
    expect(importRow[0]!.stage).toBe("match-media")

    const jobs = (await db.db.execute(sql`
      SELECT stage, batch_key FROM jobs
      WHERE import_id = ${imp.id} AND stage IN ('match-media', 'enrich', 'translate')
      ORDER BY stage, batch_key
    `)) as unknown as Array<{
      stage: string
      batch_key: string
    }>
    expect(jobs).toEqual([
      { stage: "enrich", batch_key: enrichBatchKey(1, 3) },
      { stage: "match-media", batch_key: "media" },
      { stage: "translate", batch_key: translateBatchKey(1, 3, "de") },
      { stage: "translate", batch_key: translateBatchKey(1, 3, "fr") },
    ])

    // Re-planning (sweeper recovery shape) inserts nothing new.
    await planMatchMediaStage(db.db, { importId: imp.id, storeId: imp.storeId })
    const again = (await db.db.execute(sql`
      SELECT stage, batch_key FROM jobs
      WHERE import_id = ${imp.id} AND stage IN ('match-media', 'enrich', 'translate')
    `)) as unknown as Array<{ stage: string; batch_key: string }>
    expect(again).toHaveLength(4)
  })

  it("chunks product batches at a constant size with deterministic boundaries", async () => {
    const imp = await prepareCleanedImport(
      ["SKU", "Title", "Price"],
      [
        ["A-1", "A", "1"],
        ["A-2", "B", "2"],
        ["A-3", "C", "3"],
      ]
    )
    // Barrier WITHOUT the media planner: the fan-out is planned explicitly
    // here with a shrunken batch size (as tests may shrink clean's size).
    await runGroupBarrier(imp)
    await planMatchMediaStage(
      db.db,
      { importId: imp.id, storeId: imp.storeId },
      { batchSize: 2 }
    )
    const keys = (await db.db.execute(sql`
      SELECT batch_key FROM jobs
      WHERE import_id = ${imp.id} AND stage = 'enrich' ORDER BY batch_key
    `)) as unknown as Array<{ batch_key: string }>
    expect(keys.map((k) => k.batch_key)).toEqual([
      enrichBatchKey(1, 2),
      enrichBatchKey(3, 3),
    ])
    const parsed = parseProductBatchKey(keys[0]!.batch_key)
    expect(parsed).toEqual({ start: 1, end: 2, locale: null })
    const translated = parseProductBatchKey(translateBatchKey(3, 3, "de"))
    expect(translated).toEqual({ start: 3, end: 3, locale: "de" })
  })
})

describe("re-upload and re-run convergence (EC-068)", () => {
  it("re-uploading the same sheet never yields duplicate Products — content hash dedupes the Import, Natural Keys dedupe the Products", async () => {
    const header = ["SKU", "Title", "Price"]
    const rows: Cell[][] = [
      ["TP-100", "Gießkanne", "12,50"],
      ["TP-101", "Schaufel", "4,90"],
    ]
    const contentHash = `hash-${crypto.randomUUID()}`
    const imp = await prepareCleanedImport(header, rows, contentHash)
    await runGroupBarrier(imp)

    // The content hash makes a second Import of the same file impossible.
    await expect(
      seedImport(db, { contentHash, status: "queued" })
    ).rejects.toThrow()

    // At-least-once: the barrier Job is redelivered and must converge.
    const before = await productRows(imp.id)
    const variantsBefore = await variantRows(imp.id)
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0, lease_owner = NULL,
        lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'group'
    `)
    await runGroupBarrier(imp)

    const after = await productRows(imp.id)
    expect(after).toEqual(before)
    expect(await variantRows(imp.id)).toEqual(variantsBefore)
    expect(await ledgerRows(imp.id)).toHaveLength(2)
  })
})
