/**
 * Translation Out-of-Date tracking + Translation Memory (ticket #15).
 *
 * The full Demo Mode pipeline over real Postgres, mirroring the re-import
 * key-diff suite's harness:
 *
 *   1. original import → AI translations, each pinning its source hash;
 *   2. a merchant manual fix (origin = manual) on one translation;
 *   3. a re-import that changes one Product's English text only:
 *      the manual translation is KEPT and flagged Out of Date (never
 *      overwritten), the changed Product's AI translations re-run via its
 *      birth Import's requeued translate Jobs, and the untouched Product
 *      costs no provider call at all;
 *   4. Translation Memory: deleting a translation and re-running its Job
 *      restores it from the cache with NO second provider call.
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
    sql`TRUNCATE jobs, imports, sheet_rows, import_files, provider_pauses, job_retries, translation_memory CASCADE`
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
  "Pressure sprayer 2L",
  "Brunner",
  "Garden > Watering",
  "Durable steel watering pot for indoor and outdoor use.",
  "12,50",
  "grün",
]

const FAMILY = "supplier-sheet.csv"

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

/**
 * Run the pipeline until EVERY Job of EVERY import is terminal — not just
 * the imports completed — so translate Jobs requeued onto a birth Import
 * by the group barrier's Out-of-Date hook are drained before assertions.
 */
async function runPipelineToDrained(importId: string): Promise<void> {
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
      workerId: `wt-ood-${importId.slice(0, 8)}`,
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
    try {
      await waitFor(
        "import completed and all jobs drained",
        async () => {
          const rows = (await db.db.execute(sql`
          SELECT
            (SELECT status::text FROM imports WHERE id = ${importId}) AS status,
            count(*) FILTER (WHERE status IN ('pending', 'running'))::int
              AS unsettled
          FROM jobs
        `)) as unknown as Array<{ status: string | null; unsettled: number }>
          return rows[0]!.status === "completed" && rows[0]!.unsettled === 0
        },
        30_000
      )
    } catch (error) {
      const dbg = (await db.db.execute(sql`
        SELECT import_id, stage, batch_key, status::text AS s, attempts,
               last_error
        FROM jobs ORDER BY stage, batch_key
      `)) as unknown as Array<{
        import_id: string
        stage: string
        batch_key: string
        s: string
        attempts: number
      }>
      console.log("DBG JOBS", JSON.stringify(dbg))
      throw error
    }
  } finally {
    await worker.stop()
  }
}

interface ProductRow {
  id: string
  natural_key: string
  import_id: string
}

async function familyProducts(): Promise<ProductRow[]> {
  return (await db.db.execute(sql`
    SELECT id, natural_key, import_id
    FROM products
    WHERE store_id = 'test-store' AND family_key = ${FAMILY}
    ORDER BY natural_key
  `)) as unknown as ProductRow[]
}

interface TranslationRow {
  locale: string
  field: string
  text: string
  origin: "ai" | "manual"
  out_of_date: boolean
  source_text_hash: string
}

async function translationsOf(productId: string): Promise<TranslationRow[]> {
  return (await db.db.execute(sql`
    SELECT locale, field, text, origin::text AS origin, out_of_date,
           source_text_hash
    FROM product_translations WHERE product_id = ${productId}
    ORDER BY locale, field
  `)) as unknown as TranslationRow[]
}

async function usageCountFor(productId: string): Promise<number> {
  const rows = (await db.db.execute(sql`
    SELECT count(*)::int AS n FROM provider_usage
    WHERE product_id = ${productId} AND operation = 'translate'
  `)) as unknown as Array<{ n: number }>
  return rows[0]!.n
}

async function setManual(
  productId: string,
  locale: string,
  field: string,
  text: string
): Promise<void> {
  await db.db.execute(sql`
    UPDATE product_translations
    SET origin = 'manual', text = ${text}
    WHERE product_id = ${productId} AND locale = ${locale}
      AND field = ${field}
  `)
}

describe("translation out-of-date + translation memory (ticket #15)", () => {
  it("flags manual translations Out of Date, re-runs only that Product's AI, and serves identical source text from the memory", async () => {
    // 1. Original import: both products translated by AI.
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipelineToDrained(importA)

    const products = await familyProducts()
    expect(products).toHaveLength(2)
    const red = products.find((p) => p.natural_key.includes("tp-100-r"))!
    const green = products.find((p) => p.natural_key.includes("tp-100-g"))!

    const redTranslations = await translationsOf(red.id)
    expect(redTranslations.length).toBeGreaterThan(0)
    for (const row of redTranslations) {
      expect(row.origin).toBe("ai")
      expect(row.out_of_date).toBe(false)
    }
    const redUsageBefore = await usageCountFor(red.id)
    const greenUsageBefore = await usageCountFor(green.id)
    expect(redUsageBefore).toBeGreaterThan(0)
    // Green may legitimately cost zero calls: its category/description text
    // is identical to Red's, so the Translation Memory served it.

    // 2. Merchant manual fix — the German title of the red Product.
    await setManual(red.id, "de", "title", "Gießkanne 5L (von Hand)")
    const manualBefore = (await translationsOf(red.id)).find(
      (row) => row.locale === "de" && row.field === "title"
    )!

    // 3. Re-import of the same family: ONLY the red Product's English
    //    text changed (title + description).
    const importB = await uploadSheet([
      [
        "TP-100-R",
        "Watering pot 10L",
        "Brunner",
        "Garden > Watering",
        "Extra durable galvanised steel watering pot with a brass rose.",
        "12,50",
        "rot",
      ],
      ROW_GREEN,
    ])
    await runPipelineToDrained(importB)

    // Adoption kept the red Product's birth Import.
    const after = await familyProducts()
    const redAfter = after.find((p) => p.id === red.id)!
    expect(redAfter.import_id).toBe(importA)

    const redAfterTranslations = await translationsOf(red.id)

    // Manual translation: KEPT verbatim, flagged Out of Date, origin intact.
    const manualAfter = redAfterTranslations.find(
      (row) => row.locale === "de" && row.field === "title"
    )!
    expect(manualAfter.origin).toBe("manual")
    expect(manualAfter.text).toBe("Gießkanne 5L (von Hand)")
    expect(manualAfter.out_of_date).toBe(true)
    expect(manualAfter.source_text_hash).toBe(manualBefore.source_text_hash)

    // AI translations of the CHANGED fields re-ran: new source hash pins
    // the new English, no Out-of-Date flag.
    for (const field of ["description", "category"]) {
      const row = redAfterTranslations.find(
        (entry) => entry.locale === "de" && entry.field === field
      )!
      expect(row.out_of_date).toBe(false)
      expect(row.origin).toBe("ai")
    }
    const deDescription = redAfterTranslations.find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    const beforeDescription = redTranslations.find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    expect(deDescription.source_text_hash).not.toBe(
      beforeDescription.source_text_hash
    )

    // Unchanged English text kept its original hash (untouched rows).
    const frCategory = redAfterTranslations.find(
      (row) => row.locale === "fr" && row.field === "category"
    )!
    const frCategoryBefore = redTranslations.find(
      (row) => row.locale === "fr" && row.field === "category"
    )!
    expect(frCategory.source_text_hash).toBe(frCategoryBefore.source_text_hash)
    expect(frCategory.out_of_date).toBe(false)

    // The untouched Product: no new provider call, nothing flagged.
    expect(await usageCountFor(green.id)).toBe(greenUsageBefore)
    for (const row of await translationsOf(green.id)) {
      expect(row.out_of_date).toBe(false)
    }

    // The re-run cost provider calls for the changed Product ONLY — its
    // usage grew (one call per requeued locale Job), nothing else did.
    const redUsageAfter = await usageCountFor(red.id)
    expect(redUsageAfter).toBeGreaterThan(redUsageBefore)

    // 4. Translation Memory: destroy the red Product's German description
    //    translation and requeue its Job — the cached source hash restores
    //    it with NO second provider call.
    await db.db.execute(sql`
      DELETE FROM product_translations
      WHERE product_id = ${red.id} AND locale = 'de'
        AND field = 'description'
    `)
    const usageBeforeMemoryHit = await usageCountFor(red.id)
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0,
        lease_owner = NULL, lease_expires_at = NULL, available_at = NULL
      WHERE import_id = ${importA} AND stage = 'translate'
        AND batch_key LIKE '%:de'
    `)
    await runPipelineToDrained(importA)

    const restored = (await translationsOf(red.id)).find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    expect(restored.text).toBe(deDescription.text)
    expect(restored.origin).toBe("ai")
    expect(restored.out_of_date).toBe(false)
    expect(restored.source_text_hash).toBe(deDescription.source_text_hash)
    expect(await usageCountFor(red.id)).toBe(usageBeforeMemoryHit)
  })

  it("keeps a manual translation flagged Out of Date while its source differs, then self-heals the flag for free when the source returns", async () => {
    const importA = await uploadSheet([ROW_RED, ROW_GREEN])
    await runPipelineToDrained(importA)

    const red = (await familyProducts()).find((p) =>
      p.natural_key.includes("tp-100-r")
    )!
    const deDescriptionBefore = (await translationsOf(red.id)).find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    const usageAfterFirstImport = await usageCountFor(red.id)

    // Merchant manual fix of the German description, then a re-import that
    // changes that description: the manual translation is kept verbatim and
    // flagged Out of Date (an AI row would simply have been re-translated —
    // the flag is the manual row's signal).
    await setManual(
      red.id,
      "de",
      "description",
      "Von Hand gepflegte Beschreibung."
    )
    const importB = await uploadSheet([
      [
        "TP-100-R",
        "Watering pot 5L",
        "Brunner",
        "Garden > Watering",
        "Extra durable galvanised steel watering pot with a brass rose.",
        "12,50",
        "rot",
      ],
      ROW_GREEN,
    ])
    await runPipelineToDrained(importB)
    let deDescription = (await translationsOf(red.id)).find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    expect(deDescription.origin).toBe("manual")
    expect(deDescription.text).toBe("Von Hand gepflegte Beschreibung.")
    expect(deDescription.out_of_date).toBe(true)

    // The original description returns (a price tweak keeps the sheet bytes
    // distinct so the re-import is not deduped): the description's English
    // is grounded verbatim, so the manual row's hash matches the live
    // source again — the flag self-heals, text kept, no provider call.
    const importC = await uploadSheet([
      ["TP-100-R", "Watering pot 5L", ...ROW_RED.slice(2, 5), "12,55", "rot"],
      ROW_GREEN,
    ])
    await runPipelineToDrained(importC)
    deDescription = (await translationsOf(red.id)).find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    expect(deDescription.origin).toBe("manual")
    expect(deDescription.text).toBe("Von Hand gepflegte Beschreibung.")
    expect(deDescription.out_of_date).toBe(false)
    expect(deDescription.source_text_hash).toBe(
      deDescriptionBefore.source_text_hash
    )
    // Only the description change cost provider calls (the requeued locale
    // Jobs of the birth Import); the healing re-import cost nothing new.
    expect(await usageCountFor(red.id)).toBe(usageAfterFirstImport + 2)
  })
})
