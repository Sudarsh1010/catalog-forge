/**
 * translate Stage integration tests — the DB-contract seam.
 *
 * Runs the real pipeline in-process through enrich, then the translate Jobs
 * (product-batch × locale, de/fr) on the Demo Mode stub provider. Pins the
 * per-(Product, locale, field) shape with `source_text_hash` and `origin`,
 * the round-trip guarantees (EC-089/EC-090: placeholders, HTML, numbers,
 * units, never-translate tokens survive verbatim), the source-locale no-op
 * (EC-088 — it must not cost money), and idempotent re-runs (ADR-0003).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"

import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import { createEnrichHandler } from "../src/enrich/handler.js"
import { createTranslateHandler } from "../src/translate/handler.js"
import {
  createWorker,
  createProviderRegistry,
  createStubProvider,
  defineHandlers,
  STUB_MODEL,
  STUB_PROVIDER_ID,
} from "../src/index.js"
import { planCleanStage } from "../src/clean/plan.js"
import { planGroupStage } from "../src/group/plan.js"
import { planMatchMediaStage } from "../src/media/plan.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  putTestObject,
  seedImport,
  testCache,
  testStorage,
  waitFor,
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
    sql`TRUNCATE jobs, imports, sheet_rows, import_files CASCADE`
  )
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
  "EAN",
  "Farbe",
]
const EN_DESCRIPTION =
  "Durable <strong>steel</strong> watering can, model TP-100-R: 5 l, " +
  "12,50 €, size XL, {{volume}} placeholder."
// English corpus (source locale) + one German-only product: EC-088 says
// translating German to German is a no-op that must not cost money.
const SHEET_ROWS = [
  [
    "TP-100-R",
    "Watering can 5L",
    "Brunner",
    "Garden > Watering",
    EN_DESCRIPTION,
    "12.50",
    "",
    "red",
  ],
  [
    "TP-100-G",
    "Watering can 5L",
    "Brunner",
    "Garden > Watering",
    EN_DESCRIPTION,
    "12.50",
    "",
    "green",
  ],
  [
    "TP-101",
    "Garden shovel",
    "Brunner",
    "Garden > Tools",
    "Sturdy shovel with ash handle.",
    "4.90",
    "",
    "",
  ],
  [
    "GM-01",
    "Gießkanne",
    "",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech mit Messingring.",
    "9,90",
    "",
    "",
  ],
]

async function seedUpload(): Promise<{ id: string }> {
  const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
    "text/csv"
  )
  return imp
}

function providerRegistry() {
  return createProviderRegistry([
    {
      provider: createStubProvider(),
      concurrency: 4,
      tiers: ["fast", "strong"],
    },
  ])
}

/**
 * Real pipeline through the tail of enrich; resolves once the Import has
 * entered `translate` (all enrich Batches done) with no tail work left.
 */
async function runThroughTranslate(importId: string): Promise<void> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      intake: createIntakeHandler({ storage, cache }),
      clean: createCleanHandler(),
      group: createGroupHandler(),
      "match-media": createMatchMediaHandler(),
      enrich: createEnrichHandler({ registry: providerRegistry() }),
      translate: createTranslateHandler({ registry: providerRegistry() }),
    }),
    cache,
    config: {
      workerId: `w-tr-${crypto.randomUUID().slice(0, 8)}`,
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      batchSize: 10,
    },
    planners: {
      clean: planCleanStage,
      group: planGroupStage,
      "match-media": planMatchMediaStage,
    },
  })
  worker.start()
  try {
    await waitFor(
      "import reached finalise with no tail work left",
      async () => {
        const impRows = (await db.db.execute(sql`
          SELECT stage FROM imports WHERE id = ${importId}
        `)) as unknown as Array<{ stage: string }>
        if (impRows[0]?.stage !== "finalise") return false
        const rows = (await db.db.execute(sql`
          SELECT 1 FROM jobs
          WHERE import_id = ${importId}
            AND stage IN ('enrich', 'translate')
            AND status IN ('pending', 'running')
          LIMIT 1
        `)) as unknown as unknown[]
        return rows.length === 0
      },
      20_000
    )
  } finally {
    await worker.stop()
  }
}

interface TranslationRow {
  product_id: string
  locale: string
  field: string
  text: string
  source_text_hash: string
  origin: string
  out_of_date: boolean
}

async function translationRows(locale?: string): Promise<TranslationRow[]> {
  return (await db.db.execute(sql`
    SELECT product_id, locale, field, text, source_text_hash,
           origin::text AS origin, out_of_date
    FROM product_translations
    ${locale ? sql`WHERE locale = ${locale}` : sql``}
    ORDER BY product_id, locale, field
  `)) as unknown as TranslationRow[]
}

async function productIdBySku(): Promise<Map<string, string>> {
  const rows = (await db.db.execute(sql`
    SELECT p.id, split_part(p.natural_key, ':', 2) AS sku
    FROM products p WHERE p.identity_kind = 'code'
  `)) as unknown as Array<{ id: string; sku: string }>
  return new Map(rows.map((row) => [row.sku, row.id]))
}

async function enrichedDescriptionOf(productId: string): Promise<string> {
  const rows = (await db.db.execute(sql`
    SELECT description FROM product_enrichments WHERE product_id = ${productId}
  `)) as unknown as Array<{ description: string }>
  return rows[0]!.description
}

describe("translate Stage (de/fr, per Product × locale × field)", () => {
  it("lands per-field rows with source_text_hash and origin=ai; placeholders, HTML, numbers and units survive the round-trip (EC-089, EC-090)", async () => {
    const imp = await seedUpload()
    await runThroughTranslate(imp.id)

    const ids = await productIdBySku()
    const watering = ids.get("tp-100")!
    expect(watering).toBeDefined()

    const rows = await translationRows()
    // Three translatable fields × two locales for each English product.
    const wateringRows = rows.filter((row) => row.product_id === watering)
    expect(wateringRows.map((row) => [row.locale, row.field]).sort()).toEqual([
      ["de", "category"],
      ["de", "description"],
      ["de", "title"],
      ["fr", "category"],
      ["fr", "description"],
      ["fr", "title"],
    ])
    for (const row of wateringRows) {
      expect(row.origin).toBe("ai")
      expect(row.out_of_date).toBe(false)
    }

    const de = wateringRows.find(
      (row) => row.locale === "de" && row.field === "description"
    )!
    expect(de.text).toContain("<strong>Stahl</strong>")
    expect(de.text).toContain("{{volume}}")
    expect(de.text).toContain("5 l")
    expect(de.text).toContain("12,50 €")
    expect(de.text).toContain("XL")
    // Never-translate: the SKU survives verbatim (EC-089).
    expect(de.text).toContain("TP-100-R")
    // The lexicon DID translate — this is not a silent copy.
    expect(de.text).not.toContain("Durable")
    // Tag sequence identical to the source (EC-090).
    const source = await enrichedDescriptionOf(watering)
    expect(de.text.match(/<[^>]+>/g)).toEqual(source.match(/<[^>]+>/g))
    expect(de.source_text_hash).toBe(
      createHash("sha256").update(source, "utf8").digest("hex")
    )

    const fr = wateringRows.find(
      (row) => row.locale === "fr" && row.field === "description"
    )!
    expect(fr.text).toContain("acier")
    expect(fr.text).toContain("TP-100-R")

    const deTitle = wateringRows.find(
      (row) => row.locale === "de" && row.field === "title"
    )!
    expect(deTitle.text).toContain("gießen")
  })

  it("no-ops German source text at zero cost (EC-088)", async () => {
    const imp = await seedUpload()
    await runThroughTranslate(imp.id)

    const ids = await productIdBySku()
    const german = ids.get("gm-01")!
    expect(german).toBeDefined()

    // No translation rows for the German-only product…
    const rows = await translationRows()
    expect(rows.filter((row) => row.product_id === german)).toEqual([])
    // …and no usage rows: the no-op never cost money.
    const usage = (await db.db.execute(sql`
      SELECT 1 FROM provider_usage
      WHERE product_id = ${german} AND operation = 'translate' LIMIT 1
    `)) as unknown as unknown[]
    expect(usage).toHaveLength(0)

    // …while the English products each paid for two calls (de + fr).
    const calls = (await db.db.execute(sql`
      SELECT operation::text AS operation, provider_id, model, count(*)::int AS calls
      FROM provider_usage WHERE import_id = ${imp.id}
      GROUP BY operation, provider_id, model
    `)) as unknown as Array<{
      operation: string
      provider_id: string
      model: string
      calls: number
    }>
    expect(calls).toEqual([
      {
        operation: "translate",
        provider_id: STUB_PROVIDER_ID,
        model: STUB_MODEL,
        calls: 2, // tp-100 and tp-101; German-only product skipped
      },
    ])
  })

  it("is idempotent: re-running the translate Jobs converges on identical rows (ADR-0003)", async () => {
    const imp = await seedUpload()
    await runThroughTranslate(imp.id)
    const first = await translationRows()

    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0, lease_owner = NULL,
        lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'translate'
    `)
    await runThroughTranslate(imp.id)

    expect(await translationRows()).toEqual(first)
  })
})
