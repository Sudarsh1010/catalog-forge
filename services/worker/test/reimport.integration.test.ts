/**
 * Re-import key-diff (ticket #14, EC-127): a changed re-upload of a sheet
 * family updates the catalog instead of no-op'ing or duplicating —
 *
 *   - unchanged rows are no-ops (no statement, no updated_at churn),
 *   - price/weight-like changes patch the Variant via the Fast Path with no
 *     enrichment re-run and no AI cost (adopted Products keep their birth
 *     Import, and enrich/translate plan over `products.import_id`),
 *   - other changes update the Product row,
 *   - new rows append (and ARE enriched/translated — they are new),
 *   - Variants absent from the new sheet become Missing-from-Source for the
 *     merchant to decide; a later re-import that carries them again clears
 *     the flag,
 *   - kill/restart mid re-import reconciles: counts add up, zero duplicate
 *     Products (GLOSSARY: Row Ledger, Missing-from-Source, Fast Path).
 *
 * Mirrors the idempotency suite: the real pipeline over real Postgres, the
 * Demo Mode stub provider, and the worker.integration crash gate for the
 * kill/restart shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"

import {
  createProviderRegistry,
  createStubProvider,
  createWorker,
  defineHandlers,
} from "../src/index.js"
import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import { createEnrichHandler } from "../src/enrich/handler.js"
import { createTranslateHandler } from "../src/translate/handler.js"
import { createFinaliseHandler } from "../src/finalise/handler.js"
import { planCleanStage } from "../src/clean/plan.js"
import { planGroupStage } from "../src/group/plan.js"
import { planMatchMediaStage } from "../src/media/plan.js"
import { planFinaliseStage } from "../src/finalise/plan.js"
import type { JobContext } from "../src/handlers.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  flushTestRedis,
  putTestObject,
  seedImport,
  testCache,
  testStorage,
  waitFor,
  type SeedImportOptions,
} from "./helpers"
import { csvBytes } from "./fixtures"

let db: Db
let storage: Storage
let cache: Cache

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  storage = testStorage()
  cache = testCache()
})

beforeEach(async () => {
  await db.db.execute(
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files, provider_pauses, job_retries CASCADE`
  )
  await flushTestRedis()
})

afterAll(async () => {
  await cache.close()
  await db.close()
  await dropTestDatabase()
})

const SHEET_HEADER = [
  "SKU",
  "Title",
  "Brand",
  "Category",
  "Description",
  "Price",
  "Farbe",
]

const ROW_RED = [
  "TP-100-R",
  "Watering pot 5L",
  "Brunner",
  "Garden > Watering",
  "Durable steel watering pot for indoor and outdoor use.",
  "12,50",
  "rot",
]
const ROW_GREEN = [
  "TP-100-G",
  "Watering pot 5L",
  "Brunner",
  "Garden > Watering",
  "Durable steel watering pot for indoor and outdoor use.",
  "12,50",
  "grün",
]

const FAMILY = "supplier-sheet.csv"

/** One family member: seed the upload fact and land the sheet in storage. */
async function uploadSheet(
  rows: string[][],
  seed: Partial<SeedImportOptions> = {}
): Promise<string> {
  const imp = await seedImport(db, {
    sheetHeader: SHEET_HEADER,
    originalFilename: FAMILY,
    ...seed,
  })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...rows]),
    "text/csv"
  )
  return imp.id
}

/** Run one Import through the whole Demo Mode pipeline to completion. */
async function runPipeline(importId: string, workerId: string): Promise<void> {
  const registry = createProviderRegistry([
    {
      provider: createStubProvider(),
      concurrency: 4,
      tiers: ["fast", "strong"],
    },
  ])
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      intake: createIntakeHandler({ storage, cache }),
      clean: createCleanHandler(),
      group: createGroupHandler(),
      "match-media": createMatchMediaHandler(),
      enrich: createEnrichHandler({ registry }),
      translate: createTranslateHandler({ registry }),
      finalise: createFinaliseHandler({ cache }),
    }),
    cache,
    config: {
      workerId,
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      batchSize: 4,
    },
    planners: {
      clean: planCleanStage,
      group: planGroupStage,
      "match-media": (dbRef, target) =>
        planMatchMediaStage(dbRef, target, {
          batchSize: 10,
          providerForTier: (tier) => registry.providerIdForTier(tier),
        }),
      finalise: planFinaliseStage,
    },
  })
  worker.start()
  try {
    await waitFor(
      "import completed",
      async () => {
        const rows = (await db.db.execute(sql`
          SELECT status::text AS status FROM imports WHERE id = ${importId}
        `)) as unknown as Array<{ status: string }>
        return rows[0]!.status !== "running" && rows[0]!.status !== "queued"
      },
      30_000
    )
  } finally {
    await worker.stop()
  }
  const rows = (await db.db.execute(sql`
    SELECT status::text AS status, row_count::int AS row_count
    FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{ status: string; row_count: number }>
  expect(rows[0]!.status).toBe("completed")
  expect(rows[0]!.row_count).toBeGreaterThan(0)
}

interface ProductRow {
  id: string
  natural_key: string
  natural_key_hash: string
  import_id: string
  title: string
  description: string | null
  updated_at: string
}

async function familyProducts(): Promise<ProductRow[]> {
  return (await db.db.execute(sql`
    SELECT id, natural_key, natural_key_hash, import_id, title, description,
           updated_at::text AS updated_at
    FROM products
    WHERE store_id = 'test-store' AND family_key = ${FAMILY}
    ORDER BY natural_key
  `)) as unknown as ProductRow[]
}

interface VariantRow {
  id: string
  sku: string | null
  variant_key: string
  price_cents: number | null
  price_currency: string | null
  missing_from_source: boolean
  missing_since: string | null
  source_row_index: number
  needs_review: boolean
  review_reason: string | null
  updated_at: string
}

async function variantsOf(productId: string): Promise<VariantRow[]> {
  return (await db.db.execute(sql`
    SELECT id, sku, variant_key, price_cents, price_currency,
           missing_from_source, missing_since::text AS missing_since,
           source_row_index, needs_review, review_reason,
           updated_at::text AS updated_at
    FROM variants WHERE product_id = ${productId}
    ORDER BY variant_key
  `)) as unknown as VariantRow[]
}

async function usageCount(importId: string): Promise<number> {
  const rows = (await db.db.execute(sql`
    SELECT count(*)::int AS n FROM provider_usage WHERE import_id = ${importId}
  `)) as unknown as Array<{ n: number }>
  return rows[0]!.n
}

async function ledgerOf(importId: string): Promise<{
  total: number
  terminal: number
  productIds: string[]
  variantIds: string[]
}> {
  const rows = (await db.db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE state IN ('done','needs_review','failed'))::int AS terminal,
           coalesce(array_agg(DISTINCT product_id) FILTER (WHERE product_id IS NOT NULL), '{}') AS product_ids,
           coalesce(array_agg(DISTINCT variant_id) FILTER (WHERE variant_id IS NOT NULL), '{}') AS variant_ids
    FROM row_ledger WHERE import_id = ${importId}
  `)) as unknown as Array<{
    total: number
    terminal: number
    product_ids: string[]
    variant_ids: string[]
  }>
  return {
    total: rows[0]!.total,
    terminal: rows[0]!.terminal,
    productIds: rows[0]!.product_ids,
    variantIds: rows[0]!.variant_ids,
  }
}

describe("re-import key-diff (ticket #14)", () => {
  it("same rows re-uploaded are a no-op: zero new Products, zero AI cost, ledger adds up", async () => {
    // Original import: two rows, one Product (sku:tp-100), two Variants.
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-a1")

    const productsAfterA = await familyProducts()
    expect(productsAfterA).toHaveLength(1)
    const productA = productsAfterA[0]!
    expect(productA.natural_key).toBe("sku:tp-100")
    expect(productA.import_id).toBe(importA)
    const variantsAfterA = await variantsOf(productA.id)
    expect(variantsAfterA).toHaveLength(2)

    // Re-upload: same data rows, different bytes (row order swapped) — a
    // NEW Import of the SAME family (identical bytes would have been
    // content-hash deduped by the app before reaching the worker).
    const importB = await uploadSheet([ROW_GREEN, ROW_RED], {
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    })
    await runPipeline(importB, "w-reimport-a2")

    // The Product was ADOPTED, not duplicated: still exactly one, born in A.
    const productsAfterB = await familyProducts()
    expect(productsAfterB).toHaveLength(1)
    expect(productsAfterB[0]!.id).toBe(productA.id)
    expect(productsAfterB[0]!.import_id).toBe(importA)

    // The Variants are the same rows, byte-for-byte unchanged — a true
    // no-op down to `updated_at` (the barrier issued no statements).
    const variantsAfterB = await variantsOf(productA.id)
    expect(variantsAfterB).toHaveLength(2)
    expect(variantsAfterB).toEqual(variantsAfterA)
    expect(productsAfterB[0]!.updated_at).toBe(productA.updated_at)

    // No AI cost: enrich and translate skipped the adopted Product.
    expect(await usageCount(importB)).toBe(0)

    // The Row Ledger still adds up: one terminal entry per Sheet Row,
    // pointing at the adopted Product and its Variants.
    const ledger = await ledgerOf(importB)
    expect(ledger.total).toBe(2)
    expect(ledger.terminal).toBe(2)
    expect(new Set(ledger.productIds)).toEqual(new Set([productA.id]))
    expect(new Set(ledger.variantIds)).toEqual(
      new Set(variantsAfterA.map((variant) => variant.id))
    )
  }, 60_000)

  it("price-only change patches the Variant via Fast Path: no enrichment re-run, no AI cost", async () => {
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-b1")

    const productA = (await familyProducts())[0]!
    const enrichmentA = (await db.db.execute(sql`
      SELECT id, title, updated_at::text AS updated_at
      FROM product_enrichments WHERE product_id = ${productA.id}
    `)) as unknown as Array<{ id: string; title: string; updated_at: string }>
    expect(enrichmentA).toHaveLength(1)

    // Re-upload: only TP-100-R's price changed (12,50 → 13,90).
    const importB = await uploadSheet(
      [[...ROW_RED.slice(0, 5), "13,90", ROW_RED[6]!], ROW_GREEN],
      { contentHash: crypto.randomUUID().replaceAll("-", "") }
    )
    await runPipeline(importB, "w-reimport-b2")

    const products = await familyProducts()
    expect(products).toHaveLength(1)
    expect(products[0]!.id).toBe(productA.id)
    const variants = await variantsOf(productA.id)
    const red = variants.find((variant) => variant.sku === "TP-100-R")
    const green = variants.find((variant) => variant.sku === "TP-100-G")
    expect(red!.price_cents).toBe(1390)
    expect(red!.price_currency).toBe("EUR")
    expect(green!.price_cents).toBe(1250) // untouched Variant untouched

    // No enrichment re-run: the single enrichment is A's, unchanged.
    const enrichmentB = (await db.db.execute(sql`
      SELECT id, title, updated_at::text AS updated_at
      FROM product_enrichments WHERE product_id = ${productA.id}
    `)) as unknown as Array<{ id: string; title: string; updated_at: string }>
    expect(enrichmentB).toEqual(enrichmentA)

    // No new AI cost: the whole re-import made zero provider calls.
    expect(await usageCount(importB)).toBe(0)

    const ledger = await ledgerOf(importB)
    expect(ledger.total).toBe(2)
    expect(ledger.terminal).toBe(2)
    expect(new Set(ledger.productIds)).toEqual(new Set([productA.id]))
  }, 60_000)

  it("other changed rows update the Product row", async () => {
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-c1")

    const productA = (await familyProducts())[0]!
    const enrichmentA = (await db.db.execute(sql`
      SELECT id, updated_at::text AS updated_at
      FROM product_enrichments WHERE product_id = ${productA.id}
    `)) as unknown as Array<{ id: string; updated_at: string }>

    // Re-upload: supplier rewrote title and description on BOTH rows of the
    // family (the equal titles are what corroborate the code family, EC-033,
    // so the cluster — and the Natural Key — survives the copy change).
    const newTitle = "Watering pot 5L premium"
    const newDescription =
      "Durable steel watering pot for indoor and outdoor use, now with a brass rose."
    const changed = (row: string[]): string[] => [
      row[0]!,
      newTitle,
      row[2]!,
      row[3]!,
      newDescription,
      row[5]!,
      row[6]!,
    ]
    const importB = await uploadSheet([changed(ROW_RED), changed(ROW_GREEN)], {
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    })
    await runPipeline(importB, "w-reimport-c2")

    const products = await familyProducts()
    // Updated, not duplicated.
    expect(products).toHaveLength(1)
    expect(products[0]!.id).toBe(productA.id)
    expect(products[0]!.title).toBe(newTitle)
    expect(products[0]!.description).toBe(newDescription)
    expect(products[0]!.updated_at).not.toBe(productA.updated_at)

    // The adoption patched the row without a provider call.
    expect(await usageCount(importB)).toBe(0)
    // Ticket #15: an English-text change syncs the enrichment's English
    // copy (a field patch — same row, no AI) so the re-run translation has
    // the new source; the Out-of-Date hook flags affected translations.
    const enrichmentB = (await db.db.execute(sql`
      SELECT id, updated_at::text AS updated_at
      FROM product_enrichments WHERE product_id = ${productA.id}
    `)) as unknown as Array<{ id: string; updated_at: string }>
    expect(enrichmentB[0]!.id).toBe(enrichmentA[0]!.id)
    expect(enrichmentB[0]!.updated_at).not.toBe(enrichmentA[0]!.updated_at)
  }, 60_000)

  it("new rows append and enrich; vanished Variants become Missing-from-Source until they reappear", async () => {
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-d1")
    const productA = (await familyProducts())[0]!
    const greenA = (await variantsOf(productA.id)).find(
      (variant) => variant.sku === "TP-100-G"
    )!

    // Re-upload: TP-100-G vanished, new Product TP-200 appended.
    const rowNew = [
      "TP-200-B",
      "Plant sprayer 2L",
      "Brunner",
      "Garden > Spraying",
      "Handheld sprayer with adjustable nozzle.",
      "7,90",
      "",
    ]
    const importB = await uploadSheet([ROW_RED, rowNew], {
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    })
    await runPipeline(importB, "w-reimport-d2")

    const products = await familyProducts()
    expect(products).toHaveLength(2)
    // Dropping TP-100-G renames the surviving cluster's Natural Key (the
    // family base trims to the lone code, `sku:tp-100-r`) — adoption
    // refined the adopted Product's key instead of duplicating it.
    const pot = products.find((p) => p.natural_key.startsWith("sku:tp-100"))!
    const sprayer = products.find((p) =>
      p.natural_key.startsWith("sku:tp-200")
    )!
    expect(pot.id).toBe(productA.id) // adopted
    expect(sprayer.import_id).toBe(importB) // appended, born in B

    // Missing-from-Source (GLOSSARY): TP-100-G stays, flagged, never deleted.
    const potVariants = await variantsOf(pot.id)
    const green = potVariants.find((variant) => variant.sku === "TP-100-G")!
    const red = potVariants.find((variant) => variant.sku === "TP-100-R")!
    expect(green.id).toBe(greenA.id)
    expect(green.missing_from_source).toBe(true)
    expect(green.missing_since).not.toBeNull()
    expect(red.missing_from_source).toBe(false)

    // The appended Product got the AI work; the adopted one did not.
    expect(await usageCount(importB)).toBeGreaterThan(0)
    const newUsage = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM provider_usage
      WHERE import_id = ${importB} AND product_id = ${productA.id}
    `)) as unknown as Array<{ n: number }>
    expect(newUsage[0]!.n).toBe(0)
    const sprayerEnrichment = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM product_enrichments WHERE product_id = ${sprayer.id}
    `)) as unknown as Array<{ n: number }>
    expect(sprayerEnrichment[0]!.n).toBe(1)

    const ledger = await ledgerOf(importB)
    expect(ledger.total).toBe(2)
    expect(ledger.terminal).toBe(2)

    // Third import: TP-100-G is carried again — the flag clears, the
    // merchant never lost the row, still exactly two Products.
    const importC = await uploadSheet(
      [ROW_RED, [...ROW_GREEN.slice(0, 5), "12,90", ROW_GREEN[6]!], rowNew],
      { contentHash: crypto.randomUUID().replaceAll("-", "") }
    )
    await runPipeline(importC, "w-reimport-d3")

    expect(await familyProducts()).toHaveLength(2)
    const greenC = (await variantsOf(pot.id)).find(
      (variant) => variant.sku === "TP-100-G"
    )!
    expect(greenC.id).toBe(greenA.id)
    expect(greenC.missing_from_source).toBe(false)
    expect(greenC.missing_since).toBeNull()
    expect(greenC.price_cents).toBe(1290)
  }, 90_000)

  it("an enrichment-set Needs Review flag survives an unchanged re-import untouched", async () => {
    // Original import: two rows, one Product (sku:tp-100), two Variants.
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-f1")
    const productA = (await familyProducts())[0]!

    // Simulate the post-enrichment gate (enrich's gateNeedsReview: "gating
    // never clears") having flagged the Product low-confidence.
    await db.db.execute(sql`
      UPDATE products SET needs_review = true,
             review_reason = 'Low-confidence enrichment: category'
      WHERE id = ${productA.id}
    `)
    const flagged = (await familyProducts())[0]!
    const variantsFlagged = await variantsOf(productA.id)

    // Re-upload: same data rows (order swapped, bytes distinct) — must be a
    // full no-op that PRESERVES the sticky quality flag (no UPDATE, no
    // `updated_at` churn, reason never overwritten).
    const importB = await uploadSheet([ROW_GREEN, ROW_RED], {
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    })
    await runPipeline(importB, "w-reimport-f2")

    const productsAfterB = await familyProducts()
    expect(productsAfterB).toHaveLength(1)
    expect(productsAfterB[0]!.id).toBe(productA.id)
    expect(productsAfterB[0]!.updated_at).toBe(flagged.updated_at)
    // The product rows were read back with the flag columns.
    const flaggedAfter = (await db.db.execute(sql`
      SELECT needs_review, review_reason FROM products
      WHERE id = ${productA.id}
    `)) as unknown as Array<{
      needs_review: boolean
      review_reason: string | null
    }>
    expect(flaggedAfter[0]!.needs_review).toBe(true)
    expect(flaggedAfter[0]!.review_reason).toBe(
      "Low-confidence enrichment: category"
    )
    // Zero variant UPDATEs too: byte-for-byte identical rows.
    expect(await variantsOf(productA.id)).toEqual(variantsFlagged)
    // Adoption costs no AI.
    expect(await usageCount(importB)).toBe(0)
  }, 60_000)

  it("conflicting variant prices on re-import flag the Variant; a resolving sheet clears it — the Product's sticky flag stays", async () => {
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-g1")
    const productA = (await familyProducts())[0]!

    // Re-upload: TP-100-R appears twice with DIFFERENT prices (12,50 vs
    // 99,00) — sheet evidence of a conflicting price (EC-061).
    const conflicting = [
      "TP-100-R",
      "Watering pot 5L",
      "Brunner",
      "Garden > Watering",
      "Durable steel watering pot for indoor and outdoor use.",
      "99,00",
      "rot",
    ]
    const importB = await uploadSheet([ROW_RED, conflicting], {
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    })
    await runPipeline(importB, "w-reimport-g2")

    expect(await familyProducts()).toHaveLength(1)
    const variantsB = await variantsOf(productA.id)
    const redB = variantsB.find((variant) => variant.sku === "TP-100-R")!
    const greenB = variantsB.find((variant) => variant.sku === "TP-100-G")!
    expect(redB.needs_review).toBe(true)
    expect(redB.review_reason).toContain("1250")
    expect(redB.review_reason).toContain("9900")
    expect(greenB.needs_review).toBe(false)
    // The conflict mirrors onto the Product's (sticky) flag.
    const flaggedB = (await db.db.execute(sql`
      SELECT needs_review, review_reason FROM products WHERE id = ${productA.id}
    `)) as unknown as Array<{
      needs_review: boolean
      review_reason: string | null
    }>
    expect(flaggedB[0]!.needs_review).toBe(true)

    // Third import: the sheet resolves the conflict (one row, one price).
    // The VARIANT flag clears (sheet-owned), the PRODUCT flag survives
    // (sticky — "gating never clears").
    const importC = await uploadSheet([ROW_RED, ROW_GREEN], {
      contentHash: crypto.randomUUID().replaceAll("-", ""),
    })
    await runPipeline(importC, "w-reimport-g3")

    const variantsC = await variantsOf(productA.id)
    const redC = variantsC.find((variant) => variant.sku === "TP-100-R")!
    expect(redC.needs_review).toBe(false)
    expect(redC.review_reason).toBeNull()
    const flaggedC = (await db.db.execute(sql`
      SELECT needs_review, review_reason FROM products WHERE id = ${productA.id}
    `)) as unknown as Array<{
      needs_review: boolean
      review_reason: string | null
    }>
    expect(flaggedC[0]!.needs_review).toBe(true)
    expect(flaggedC[0]!.review_reason).toContain("Conflicting prices")
  }, 90_000)

  it("kill/restart mid re-import reconciles: counts add up, zero duplicates", async () => {
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipeline(importA, "w-reimport-e1")
    const productA = (await familyProducts())[0]!
    const enrichmentsA = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM product_enrichments
    `)) as unknown as Array<{ n: number }>

    // The changed re-import: price change + appended Product + dropped Variant.
    const rowNew = [
      "TP-300-S",
      "Garden hose 20m",
      "Brunner",
      "Garden > Watering",
      "Kink-resistant garden hose with brass fittings.",
      "24,00",
      "",
    ]
    const importB = await uploadSheet(
      [[...ROW_RED.slice(0, 5), "13,90", ROW_RED[6]!], rowNew],
      { contentHash: crypto.randomUUID().replaceAll("-", "") }
    )

    // First worker "dies" mid re-import: the group barrier hangs in-flight.
    const crashGate = Promise.withResolvers<void>()
    let barrierRan = false
    const registry = createProviderRegistry([
      {
        provider: createStubProvider(),
        concurrency: 4,
        tiers: ["fast", "strong"],
      },
    ])
    const crashingWorker = createWorker({
      db,
      handlers: defineHandlers({
        intake: createIntakeHandler({ storage, cache }),
        clean: createCleanHandler(),
        group: (ctx: JobContext): Promise<void> => {
          if (barrierRan) return createGroupHandler()(ctx)
          barrierRan = true
          return (async () => {
            await crashGate.promise
            throw new Error("worker died mid-reimport")
          })()
        },
        "match-media": createMatchMediaHandler(),
        enrich: createEnrichHandler({ registry }),
        translate: createTranslateHandler({ registry }),
        finalise: createFinaliseHandler({ cache }),
      }),
      cache,
      config: {
        workerId: "w-reimport-e2-crash",
        claimIntervalMs: 10,
        sweepIntervalMs: 25,
        batchSize: 4,
      },
      planners: {
        clean: planCleanStage,
        group: planGroupStage,
        "match-media": (dbRef, target) =>
          planMatchMediaStage(dbRef, target, {
            batchSize: 10,
            providerForTier: (tier) => registry.providerIdForTier(tier),
          }),
        finalise: planFinaliseStage,
      },
    })
    crashingWorker.start()
    await waitFor("crashing worker holds the group barrier", async () => {
      const rows = (await db.db.execute(sql`
        SELECT status::text AS status FROM jobs
        WHERE import_id = ${importB} AND stage = 'group'
      `)) as unknown as Array<{ status: string }>
      return rows[0]?.status === "running"
    })

    // Crash: stop the loops, release the gate so stop() settles, expire the
    // leases a real SIGKILL would leave behind.
    const stopping = crashingWorker.stop()
    crashGate.resolve()
    await stopping
    await db.db.execute(sql`
      UPDATE jobs SET lease_expires_at = now() - interval '1 second'
      WHERE status = 'running'
    `)

    // Restart: the fresh worker reclaims the barrier and finishes the job.
    await runPipeline(importB, "w-reimport-e2-restart")

    // The barrier really ran twice (at-least-once, ADR-0003).
    const groupJob = (await db.db.execute(sql`
      SELECT attempts::int AS attempts, status::text AS status FROM jobs
      WHERE import_id = ${importB} AND stage = 'group'
    `)) as unknown as Array<{ attempts: number; status: string }>
    expect(groupJob[0]!.status).toBe("completed")
    expect(groupJob[0]!.attempts).toBe(2)

    // Reconciliation: zero duplicate Products across the family — exactly
    // the refined watering pot and the appended hose, each one row.
    const products = await familyProducts()
    expect(products).toHaveLength(2)
    expect(new Set(products.map((p) => p.natural_key_hash)).size).toBe(2)

    // Exactly the expected diff landed once, not twice: TP-100-R patched,
    // TP-100-G missing, TP-300 appended and enriched once.
    const pot = products.find((p) => p.natural_key.startsWith("sku:tp-100"))!
    const hose = products.find((p) => p.natural_key.startsWith("sku:tp-300"))!
    expect(pot.id).toBe(productA.id)
    expect(hose.import_id).toBe(importB)
    const potVariants = await variantsOf(pot.id)
    const red = potVariants.find((variant) => variant.sku === "TP-100-R")!
    const green = potVariants.find((variant) => variant.sku === "TP-100-G")!
    expect(red.price_cents).toBe(1390)
    expect(green.missing_from_source).toBe(true)
    const variantsAll = (await db.db.execute(sql`
      SELECT count(*)::int AS n,
             count(DISTINCT (product_id, variant_key_hash))::int AS distinct_keys
      FROM variants
      WHERE store_id = 'test-store' AND product_id IN (SELECT id FROM products WHERE store_id = 'test-store')
    `)) as unknown as Array<{ n: number; distinct_keys: number }>
    expect(variantsAll[0]!.n).toBe(variantsAll[0]!.distinct_keys) // no duplicate Variants

    // The adopted Product's enrichment was NOT redone by the crash/re-run.
    const enrichments = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM product_enrichments
      WHERE product_id = ${productA.id}
    `)) as unknown as Array<{ n: number }>
    expect(enrichments[0]!.n).toBe(1)
    expect(enrichments[0]!.n).toBe(enrichmentsA[0]!.n)
    const adoptedUsage = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM provider_usage WHERE product_id = ${productA.id} AND import_id = ${importB}
    `)) as unknown as Array<{ n: number }>
    expect(adoptedUsage[0]!.n).toBe(0)

    // Counts add up: the ledger covers every Sheet Row of the re-import,
    // all terminal, and the appended Product was enriched exactly once.
    const ledger = await ledgerOf(importB)
    expect(ledger.total).toBe(2)
    expect(ledger.terminal).toBe(2)
    expect(ledger.productIds.sort()).toEqual([productA.id, hose.id].sort())
    const hoseEnrichment = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM product_enrichments WHERE product_id = ${hose.id}
    `)) as unknown as Array<{ n: number }>
    expect(hoseEnrichment[0]!.n).toBe(1)
  }, 90_000)
})
