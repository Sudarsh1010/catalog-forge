/**
 * Layer 2 eval end-to-end (Ticket #20): the real pipeline up through enrich,
 * driven by an INJECTED fake provider (the same seam the OpenAI integration
 * suite uses — no API key involved), then the actual Layer 2 scorer
 * (scripts/eval-score-l2.ts) grading the enrichment rows that landed in the
 * database. Pins the acceptance rule: a Claim traceability failure — a cited
 * row outside the Product's sourceRows, or text the cited row does not state
 * — is scored as an ERROR, never partially credited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"

import {
  createProviderRegistry,
  createWorker,
  defineHandlers,
  type EnrichInput,
  type EnrichmentResult,
  type Provider,
  type TranslateInput,
  type TranslateResult,
} from "../src/index.js"
import type { ProviderCall } from "../src/provider/port.js"
import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import { createEnrichHandler } from "../src/enrich/handler.js"
import { planCleanStage } from "../src/clean/plan.js"
import { planGroupStage } from "../src/group/plan.js"
import { planMatchMediaStage } from "../src/media/plan.js"
import { gradeProduct, type EvalRun } from "../scripts/eval-score-l2.js"
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
  await flushTestRedis()
})

afterAll(async () => {
  await cache.close()
  await db.close()
  await dropTestDatabase()
})

const SHEET_HEADER = ["SKU", "Title", "Category", "Description", "Price"]

// Row 1 + row 2 collapse into one Product; row 3 stands alone. Blumentopf
// (row 3) has no description — anything the fake provider asserts about it
// is ungroundable by construction.
const SHEET_ROWS = [
  [
    "TP-100-R",
    "Gießkanne 5L",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech.",
    "12,50",
  ],
  [
    "TP-100-G",
    "Gießkanne 5L",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech.",
    "12,50",
  ],
  ["BM-01", "Blumentopf", "Garten > Kübel", "", "3,90"],
]

/**
 * The fake "AI": grounded, correct output for the Gießkanne; for the
 * Blumentopf it hallucinates — a claim citing row 99 (outside sourceRows)
 * and an invented tag — exactly the Layer 2 error cases.
 */
const fakeProvider: Provider = {
  id: "fake-l2",
  enrich(input: EnrichInput): Promise<ProviderCall<EnrichmentResult>> {
    const isGiesskanne = input.product.title.startsWith("Gießkanne")
    const value: EnrichmentResult = {
      title: input.product.title,
      handle: input.product.naturalKey,
      description: isGiesskanne ? "Robuste Gießkanne aus Stahlblech." : "",
      category: isGiesskanne ? "Garten > Bewässerung" : "Garten > Kübel",
      tags: isGiesskanne ? ["Stahlblech"] : ["Bambus"],
      attributes: {},
      confidence: {
        title: 90,
        handle: 90,
        description: 90,
        category: 90,
        tags: 90,
        attributes: 90,
      },
      status: "ready",
      claims: isGiesskanne
        ? [
            {
              text: "Robuste Gießkanne aus Stahlblech",
              sourceRowIndex: 1,
              sourceColumn: "Description",
            },
          ]
        : [
            {
              text: "Frostsafe bis minus 20 Grad",
              sourceRowIndex: 99,
            },
          ],
      reviewReasons: [],
      sourceRows: input.sourceRows,
    }
    return Promise.resolve({
      value,
      usage: {
        providerId: "fake-l2",
        model: "fake-strong",
        tokensIn: 100,
        tokensOut: 50,
      },
    })
  },
  translate(_input: TranslateInput): Promise<ProviderCall<TranslateResult>> {
    return Promise.resolve({
      value: { fields: {} },
      usage: {
        providerId: "fake-l2",
        model: "fake-strong",
        tokensIn: 10,
        tokensOut: 5,
      },
    })
  },
}

interface EnrichmentDbRow {
  product_id: string
  source_row_indexes: number[]
  title: string
  category: string
  tags: string[]
  claims: Array<{
    text: string
    sourceRowIndex: number
    sourceColumn?: string
  }>
}

describe("Layer 2 scoring over a real pipeline run (fake provider)", () => {
  it("scores grounded output as hits and traceability failures as errors", async () => {
    const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
      "text/csv"
    )

    const worker = createWorker({
      db,
      handlers: defineHandlers({
        intake: createIntakeHandler({ storage, cache }),
        clean: createCleanHandler(),
        group: createGroupHandler(),
        "match-media": createMatchMediaHandler(),
        enrich: createEnrichHandler({
          registry: createProviderRegistry([
            {
              provider: fakeProvider,
              concurrency: 4,
              tiers: ["fast", "strong"],
            },
          ]),
        }),
      }),
      cache,
      config: {
        workerId: `w-l2-${crypto.randomUUID().slice(0, 8)}`,
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
      await waitFor("enrich batches completed", async () => {
        const rows = (await db.db.execute(sql`
          SELECT 1 FROM jobs
          WHERE import_id = ${imp.id}
            AND stage = 'enrich'
            AND status IN ('pending', 'running')
          LIMIT 1
        `)) as unknown as unknown[]
        const enrichments = (await db.db.execute(sql`
          SELECT count(*)::int AS n FROM product_enrichments
          WHERE import_id = ${imp.id}
        `)) as unknown as Array<{ n: number }>
        return rows.length === 0 && (enrichments[0]?.n ?? 0) === 2
      })
    } finally {
      await worker.stop()
    }

    const enrichments = (await db.db.execute(sql`
        SELECT product_id::text AS product_id, source_row_indexes,
               title, category, tags, claims
        FROM product_enrichments WHERE import_id = ${imp.id}
      `)) as unknown as EnrichmentDbRow[]
    const cleaned = (await db.db.execute(sql`
        SELECT row_index, values FROM cleaned_rows WHERE import_id = ${imp.id}
      `)) as unknown as EvalRun["cleaned"]

    const run: EvalRun = {
      gold: { sheet: "test", products: [], quantities: [], parkedPhotos: [] },
      header: SHEET_HEADER,
      products: [],
      variants: [],
      enrichments: [],
      matched: [],
      parked: [],
      cleaned,
    }

    const giesskanne = enrichments.find((row) =>
      row.title.startsWith("Gießkanne")
    )
    const blumentopf = enrichments.find((row) => row.title === "Blumentopf")
    expect(giesskanne).toBeDefined()
    expect(blumentopf).toBeDefined()

    // Grounded: claim cites row 1 (in sourceRows [1, 2]) and its text is the
    // cited row's description; tag "Stahlblech" traces to the description.
    const goodGrade = gradeProduct(
      run,
      {
        id: "P01",
        title: "Gießkanne 5L",
        sourceRows: [1, 2],
        variants: [],
        photos: [],
        claims: ["Robuste Gießkanne aus Stahlblech"],
      },
      {
        title: giesskanne!.title,
        category: giesskanne!.category,
        tags: giesskanne!.tags,
        claims: giesskanne!.claims,
      },
      "Category"
    )
    expect(goodGrade.title).toBe(true)
    expect(goodGrade.category).toBe(true)
    expect(goodGrade.tags).toBe(true)
    expect(goodGrade.claims).toBe(true)

    // Traceability failures are ERRORS: row 99 is outside sourceRows, the
    // tag "Bambus" appears nowhere in the source rows.
    const badGrade = gradeProduct(
      run,
      {
        id: "P02",
        title: "Blumentopf",
        sourceRows: [3],
        variants: [],
        photos: [],
      },
      {
        title: blumentopf!.title,
        category: blumentopf!.category,
        tags: blumentopf!.tags,
        claims: blumentopf!.claims,
      },
      "Category"
    )
    expect(badGrade.claims).toBe(false)
    expect(badGrade.failures.join(" ")).toMatch(/not in sourceRows/)
    expect(badGrade.tags).toBe(false)
  })
})
