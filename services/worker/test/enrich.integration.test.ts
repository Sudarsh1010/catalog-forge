/**
 * enrich Stage integration tests — the DB-contract seam.
 *
 * Runs the real pipeline in-process (adoption → intake → clean → group
 * barrier → match-media) and then the enrich Jobs on the Demo Mode stub
 * provider (zero API keys). Asserts the brief's JSON shape, determinism,
 * the zero-Claims rule (EC-075), low-confidence gating with mirrored Row
 * Ledger states (EC-099, GLOSSARY: Needs Review), and per-call synthetic
 * usage aggregatable by Import and Product.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"

import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import { createEnrichHandler } from "../src/enrich/handler.js"
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
// Two rows collapse into one Product (code family); Schaufel and Blumentopf
// stand alone. Blumentopf has no description/category → low Confidence.
const SHEET_ROWS = [
  [
    "TP-100-R",
    "Gießkanne 5L",
    "Brunner",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech.",
    "12,50",
    "",
    "rot",
  ],
  [
    "TP-100-G",
    "Gießkanne 5L",
    "Brunner",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech.",
    "12,50",
    "",
    "grün",
  ],
  [
    "TP-101",
    "Schaufel",
    "Brunner",
    "Garten > Werkzeug",
    "Stabile Schaufel mit Eschengriff.",
    "4,90",
    "",
    "",
  ],
  ["BM-01", "Blumentopf", "", "", "", "3,90", "", ""],
]

async function seedUpload(): Promise<{ id: string; storeId: string }> {
  const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
    "text/csv"
  )
  return imp
}

function tailHandlers() {
  return defineHandlers({
    enrich: createEnrichHandler({
      registry: createProviderRegistry([
        {
          provider: createStubProvider(),
          concurrency: 4,
          tiers: ["fast", "strong"],
        },
      ]),
    }),
  })
}

/**
 * Real pipeline through match-media and the enrich Jobs. One worker carries
 * EVERY handler up to enrich — in production each worker registers all
 * Stages, so the moment the completion transaction flips the Import to
 * `enrich`, any worker can claim the Batch. A handler-less gap here would
 * burn attempts between the two waits.
 */
async function runThroughEnrich(importId: string): Promise<void> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      intake: createIntakeHandler({ storage, cache }),
      clean: createCleanHandler(),
      group: createGroupHandler(),
      "match-media": createMatchMediaHandler(),
      ...tailHandlers(),
    }),
    cache,
    config: {
      workerId: `w-pipe-${crypto.randomUUID().slice(0, 8)}`,
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
    // Reached-translate is the real completion signal: the Import only
    // enters `translate` when the last enrich Job completed, and the wait
    // then holds until the handler-less translate Jobs burned their
    // attempts (this suite pins enrich only).
    await waitFor(
      "import reached translate with no tail work left",
      async () => {
        const impRows = (await db.db.execute(sql`
          SELECT stage FROM imports WHERE id = ${importId}
        `)) as unknown as Array<{ stage: string }>
        if (impRows[0]?.stage !== "translate") return false
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

interface EnrichmentRow {
  product_id: string
  title: string
  handle: string
  description: string
  category: string
  tags: string[]
  attributes: Record<string, string>
  confidence: Record<string, number>
  status: string
  claims: unknown[]
  review_reasons: string[]
  source_row_indexes: number[]
  field_origins: Record<string, string>
}

async function enrichmentRows(): Promise<EnrichmentRow[]> {
  return (await db.db.execute(sql`
    SELECT product_id, title, handle, description, category, tags, attributes,
           confidence, status::text AS status, claims, review_reasons,
           source_row_indexes, field_origins
    FROM product_enrichments
    ORDER BY title
  `)) as unknown as EnrichmentRow[]
}

async function productsById(): Promise<
  Map<
    string,
    {
      id: string
      title: string
      needs_review: boolean
      review_reason: string | null
      natural_key: string
    }
  >
> {
  const rows = (await db.db.execute(sql`
    SELECT id, title, needs_review, review_reason, natural_key
    FROM products ORDER BY natural_key
  `)) as unknown as Array<{
    id: string
    title: string
    needs_review: boolean
    review_reason: string | null
    natural_key: string
  }>
  return new Map(rows.map((row) => [row.natural_key, row]))
}

describe("enrich Stage on the stub provider (Demo Mode)", () => {
  it("writes the brief's JSON shape with zero Claims and gates low-confidence Products Needs Review (EC-075, EC-099)", async () => {
    const imp = await seedUpload()
    await runThroughEnrich(imp.id)

    const rows = await enrichmentRows()
    expect(rows).toHaveLength(3)
    const byProduct = await productsById()
    const gieskanne = rows.find((row) => row.title === "Brunner Gießkanne 5L")!
    expect(gieskanne).toBeDefined()

    // Title composed from cleaned fields; handle slugs it with the
    // natural-key-hash suffix; description/category grounded in the source.
    expect(gieskanne!.description).toBe("Robuste Gießkanne aus Stahlblech.")
    expect(gieskanne!.category).toBe("Garten > Bewässerung")
    expect(gieskanne!.handle).toMatch(
      new RegExp(`^brunner-giesskanne-5l-[0-9a-f]{8}$`)
    )
    expect(gieskanne!.tags).toEqual(["brunner", "garten > bewässerung", "grün"])
    // Variant axes merge first-value-wins in variant_key order (deterministic):
    // `sku:tp-100-g` sorts before `sku:tp-100-r`, so grün represents Farbe.
    expect(gieskanne!.attributes).toEqual({ Farbe: "grün" })
    expect(gieskanne!.status).toBe("ready")
    // EC-075: the stub invents nothing — no claims, ever.
    expect(gieskanne!.claims).toEqual([])
    expect(gieskanne!.confidence).toMatchObject({
      title: 95,
      handle: 95,
      description: 90,
      category: 90,
      tags: 80,
      attributes: 90,
    })

    // Low-confidence gating: no source description/category → Needs Review
    // with reasons, mirrored on the Product and the Row Ledger.
    const blumentopfRow = rows.find((row) => row.title === "Blumentopf")!
    expect(blumentopfRow!.status).toBe("needs_review")
    expect(blumentopfRow!.review_reasons.length).toBeGreaterThan(0)
    const blumentopf = byProduct.get("sku:bm-01")!
    expect(blumentopf!.needs_review).toBe(true)
    expect(blumentopf!.review_reason).toMatch(/[Cc]onfidence/)
    const grounded = byProduct.get("sku:tp-100")!
    expect(grounded!.needs_review).toBe(false)

    const ledger = (await db.db.execute(sql`
      SELECT state::text AS state, count(*)::int AS count
      FROM row_ledger WHERE import_id = ${imp.id}
      GROUP BY state
    `)) as unknown as Array<{ state: string; count: number }>
    const byState = Object.fromEntries(
      ledger.map((row) => [row.state, row.count])
    )
    expect(byState).toEqual({ done: 3, needs_review: 1 })
  })

  it("is deterministic: re-running the enrich Jobs reproduces identical output (ADR-0003)", async () => {
    const imp = await seedUpload()
    await runThroughEnrich(imp.id)
    const first = await enrichmentRows()

    // Redeliver the enrich Jobs: same Batches, same input, same output.
    // The Import sits in `translate` now, which is past `enrich` — the gate
    // lets the redelivered Batches claim.
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0, lease_owner = NULL,
        lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'enrich'
    `)
    await runThroughEnrich(imp.id)

    expect(await enrichmentRows()).toEqual(first)
  })

  it("keeps merchant-edited fields over later AI output (GLOSSARY: Origin)", async () => {
    const imp = await seedUpload()
    await runThroughEnrich(imp.id)

    // The merchant edits Blumentopf: the two fields the stub composed
    // (description, title) become manual with confidence 100; the review
    // reasons about them are answered.
    const products = await productsById()
    const blumentopf = products.get("sku:bm-01")!
    await db.db.execute(sql`
      UPDATE product_enrichments SET
        title = 'Blumentopf klassisch',
        description = 'Von Hand gegossen, aus Terrakotta.',
        field_origins = '{"title": "manual", "description": "manual"}'::jsonb,
        confidence = confidence || '{"title": 100, "description": 100}'::jsonb,
        status = 'ready',
        review_reasons = '[]'::jsonb,
        updated_at = now()
      WHERE product_id = ${blumentopf!.id}
    `)

    // Later AI output: the enrich Jobs re-run (a redelivered or Re-run
    // Job — same upsert path either way, ADR-0003).
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0, lease_owner = NULL,
        lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'enrich'
    `)
    await runThroughEnrich(imp.id)

    const rows = await enrichmentRows()
    expect(rows).toHaveLength(3) // no duplicates — the upsert converged
    const edited = rows.find((row) => row.title === "Blumentopf klassisch")!
    expect(edited).toBeDefined()
    // The merchant's wording survived; the AI's recomposition did not land.
    expect(edited!.description).toBe("Von Hand gegossen, aus Terrakotta.")
    expect(edited!.field_origins).toMatchObject({
      title: "manual",
      description: "manual",
    })
    expect(edited!.confidence).toMatchObject({ title: 100, description: 100 })
    // The stub re-derived everything non-manual — tags (from empty
    // brand/category/attributes) stay empty, nothing clobbered the edits.
    expect(edited!.tags).toEqual([])
    // The description reason is answered (manual); the category reason —
    // the stub still composes the category — keeps the Product flagged.
    expect(edited!.status).toBe("needs_review")
    expect(edited!.review_reasons).toHaveLength(1)
    expect(edited!.review_reasons[0]).toContain("category:")
  })

  it("records synthetic usage per call, aggregatable by Import and Product", async () => {
    const imp = await seedUpload()
    await runThroughEnrich(imp.id)

    const usage = (await db.db.execute(sql`
      SELECT operation::text AS operation, provider_id, model, tokens_in,
             tokens_out, cost_micros, product_id
      FROM provider_usage WHERE import_id = ${imp.id}
    `)) as unknown as Array<{
      operation: string
      provider_id: string
      model: string
      tokens_in: number
      tokens_out: number
      cost_micros: number
      product_id: string | null
    }>
    // One enrich call per Product.
    expect(usage).toHaveLength(3)
    for (const row of usage) {
      expect(row.operation).toBe("enrich")
      expect(row.provider_id).toBe(STUB_PROVIDER_ID)
      expect(row.model).toBe(STUB_MODEL)
      expect(row.tokens_in).toBeGreaterThan(0)
      expect(row.tokens_out).toBeGreaterThan(0)
      expect(row.cost_micros).toBeGreaterThan(0)
      expect(row.product_id).not.toBeNull()
    }

    // Aggregation shape: per Import and per Product both reconcile.
    const totals = (await db.db.execute(sql`
      SELECT coalesce(sum(cost_micros), 0)::int AS total
      FROM provider_usage WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ total: number }>
    const perProduct = (await db.db.execute(sql`
      SELECT product_id, sum(cost_micros)::int AS total
      FROM provider_usage WHERE import_id = ${imp.id}
      GROUP BY product_id
    `)) as unknown as Array<{ product_id: string; total: number }>
    const sumOfRows = usage.reduce((sum, row) => sum + row.cost_micros, 0)
    expect(totals[0]!.total).toBe(sumOfRows)
    expect(perProduct.map((row) => row.total).sort((a, b) => a - b)).toEqual(
      [
        ...usage
          .reduce((map, row) => {
            map.set(
              row.product_id!,
              (map.get(row.product_id!) ?? 0) + row.cost_micros
            )
            return map
          }, new Map<string, number>())
          .values(),
      ].sort((a, b) => a - b)
    )
  })
})
