/**
 * End-to-end Demo Mode pipeline — the DB-contract seam.
 *
 * Seeds an Import (sheet + photos via the established fixtures path), runs
 * the real worker loops in-process with the FULL seven-Stage handler set on
 * the stub provider, and asserts the Import reaches `done` with ZERO API
 * keys: the ledger adds up (including needs_review and failed rows), the
 * enrich output is deterministic across two runs, and synthetic usage rows
 * aggregate by Import and Product. A second scenario drives the
 * empty-Batch shape (nothing groups) through the stage-advance sweeper.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { importStreamKey } from "@workspace/pipeline"

import {
  createWorker,
  createProviderRegistry,
  createStubProvider,
  defineHandlers,
  STUB_PROVIDER_ID,
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
  seedImportFile,
  testCache,
  testStorage,
  waitFor,
} from "./helpers"
import { csvBytes, PNG_BYTES } from "./fixtures"

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
const SHEET_ROWS = [
  [
    "TP-100-R",
    "Watering can 5L",
    "Brunner",
    "Garden > Watering",
    "Durable steel body, 5 l.",
    "12.50",
    "red",
  ],
  [
    "TP-100-G",
    "Watering can 5L",
    "Brunner",
    "Garden > Watering",
    "Durable steel body, 5 l.",
    "12.50",
    "green",
  ],
  // Grouped on its SKU, but nothing to ground description/category — the
  // enrichment gates it Needs Review even in Demo Mode (EC-099).
  ["BM-01", "Flower pot", "", "", "", "3.90", ""],
  // No supplier code, no title — nothing to group by: Failed (EC-031).
  ["", "", "", "", "", "1.00", ""],
]

/** Seed the queued Import: sheet in storage, two photos, one ZIP-less. */
async function seedUpload(): Promise<{ id: string }> {
  const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
    "text/csv"
  )
  for (const [filename, key] of [
    ["tp-100-r-01.jpg", `t5-tests/${imp.id}/tp-100-r-01.jpg`],
    ["IMG_4472.JPG", `t5-tests/${imp.id}/IMG_4472.JPG`],
  ] as const) {
    await putTestObject(storage, key, PNG_BYTES, "image/png")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo",
      objectKey: key,
      filename,
      contentType: "image/png",
    })
  }
  return imp
}

/** Demo Mode registry: the stub occupies every tier — no key anywhere. */
function demoRegistry() {
  return createProviderRegistry([
    {
      provider: createStubProvider(),
      concurrency: 4,
      tiers: ["fast", "strong"],
    },
  ])
}

function fullWorker(workerId: string) {
  return createWorker({
    db,
    handlers: defineHandlers({
      intake: createIntakeHandler({ storage, cache }),
      clean: createCleanHandler(),
      group: createGroupHandler(),
      "match-media": createMatchMediaHandler(),
      enrich: createEnrichHandler({ registry: demoRegistry() }),
      translate: createTranslateHandler({ registry: demoRegistry() }),
      finalise: createFinaliseHandler({ cache }),
    }),
    cache,
    config: {
      workerId,
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      batchSize: 10,
    },
    planners: {
      clean: planCleanStage,
      group: planGroupStage,
      "match-media": planMatchMediaStage,
      finalise: planFinaliseStage,
    },
  })
}

/** Run the full pipeline to `completed` (or timeout). */
async function runToDone(importId: string): Promise<void> {
  const worker = fullWorker(`w-e2e-${crypto.randomUUID().slice(0, 8)}`)
  worker.start()
  try {
    await waitFor(
      "import completed",
      async () => {
        const rows = (await db.db.execute(sql`
          SELECT status FROM imports WHERE id = ${importId}
        `)) as unknown as Array<{ status: string }>
        return rows[0]?.status === "completed"
      },
      30_000
    )
  } finally {
    await worker.stop()
  }
}

async function importRow(importId: string): Promise<{
  status: string
  stage: string
  row_count: number | null
}> {
  const rows = (await db.db.execute(sql`
    SELECT status::text AS status, stage, row_count FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{
    status: string
    stage: string
    row_count: number | null
  }>
  return rows[0]!
}

async function ledgerCounts(importId: string): Promise<{
  done: number
  needs_review: number
  failed: number
}> {
  const rows = (await db.db.execute(sql`
    SELECT state::text AS state, count(*)::int AS count
    FROM row_ledger WHERE import_id = ${importId} GROUP BY state
  `)) as unknown as Array<{ state: string; count: number }>
  const counts = { done: 0, needs_review: 0, failed: 0 }
  for (const row of rows) {
    counts[row.state as keyof typeof counts] = row.count
  }
  return counts
}

interface EnrichmentSnapshot {
  title: string
  handle: string
  description: string
  category: string
  tags: unknown
  attributes: unknown
  confidence: unknown
  status: string
  claims: unknown
  review_reasons: unknown
  source_row_indexes: unknown
  messiness: number
}

async function enrichmentSnapshot(): Promise<EnrichmentSnapshot[]> {
  return (await db.db.execute(sql`
    SELECT title, handle, description, category, tags, attributes, confidence,
           status::text AS status, claims, review_reasons,
           source_row_indexes, messiness
    FROM product_enrichments ORDER BY handle
  `)) as unknown as EnrichmentSnapshot[]
}

describe("Demo Mode end-to-end (no API keys)", () => {
  it("takes sheet + photos to `done`: ledger adds up incl. needs_review and failed, enrich is deterministic, usage aggregates", async () => {
    // The stub provider takes no credentials — the port cannot carry a key.
    // Ticket 6 added the chaos OPTIONS argument (env in dev, tests here);
    // keyless construction still yields the Demo Mode provider.
    expect(createStubProvider().id).toBe(STUB_PROVIDER_ID)

    const imp = await seedUpload()
    await runToDone(imp.id)

    const row = await importRow(imp.id)
    expect(row.status).toBe("completed")
    expect(row.row_count).toBe(SHEET_ROWS.length)

    // Ledger counts add up to the sheet — with every terminal state present.
    const counts = await ledgerCounts(imp.id)
    expect(counts.done + counts.needs_review + counts.failed).toBe(
      SHEET_ROWS.length
    )
    expect(counts.done).toBe(2) // the watering-can family
    expect(counts.needs_review).toBe(1) // the un-groundable pot (EC-099)
    expect(counts.failed).toBe(1) // the identity-less row (EC-031)

    // The media stage ran on the way through: one match, one parked.
    const photos = (await db.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM product_photos WHERE import_id = ${imp.id}) AS matched,
        (SELECT count(*)::int FROM parked_photos WHERE import_id = ${imp.id}) AS parked
    `)) as unknown as Array<{ matched: number; parked: number }>
    expect(photos[0]).toEqual({ matched: 1, parked: 1 })

    // Determinism: redeliver the enrich Jobs — identical output, and the
    // completed Import stays completed.
    const first = await enrichmentSnapshot()
    expect(first).toHaveLength(2)
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0, lease_owner = NULL,
        lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'enrich'
    `)
    await runToDone(imp.id)
    expect(await enrichmentSnapshot()).toEqual(first)
    expect((await importRow(imp.id)).status).toBe("completed")

    // Usage rows exist per call, all stub-served, and aggregate by Import
    // and Product.
    const usage = (await db.db.execute(sql`
      SELECT product_id, tokens_in, tokens_out, cost_micros, provider_id
      FROM provider_usage WHERE import_id = ${imp.id}
    `)) as unknown as Array<{
      product_id: string | null
      tokens_in: number
      tokens_out: number
      cost_micros: number
      provider_id: string
    }>
    expect(usage.length).toBeGreaterThanOrEqual(3)
    expect(usage.every((row2) => row2.provider_id === STUB_PROVIDER_ID)).toBe(
      true
    )
    const byImport = (await db.db.execute(sql`
      SELECT coalesce(sum(cost_micros), 0)::int AS total
      FROM provider_usage WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ total: number }>
    expect(byImport[0]!.total).toBe(
      usage.reduce((sum, row2) => sum + row2.cost_micros, 0)
    )
    const byProduct = (await db.db.execute(sql`
      SELECT product_id, sum(cost_micros)::int AS total
      FROM provider_usage WHERE import_id = ${imp.id} GROUP BY product_id
      ORDER BY product_id
    `)) as unknown as Array<{ product_id: string; total: number }>
    expect(byProduct.reduce((sum, row2) => sum + row2.total, 0)).toBe(
      byImport[0]!.total
    )

    // The loop closed publicly: one import_done on the event stream.
    const events = await cache.redis.xrange(importStreamKey(imp.id), "-", "+")
    const types = events.map((entry) => {
      const fields = entry[1]
      const index = fields.findIndex((field) => field === "type")
      return fields[index + 1] ?? ""
    })
    expect(types).toContain("import_done")
  })

  it("completes a sheet where nothing groups: empty enrich/translate Batches advance and finalise still adds up", async () => {
    const header = ["SKU", "Title", "Price"]
    const rows = [["", "", "5,00"]] // no identity → Failed, zero Products
    const imp = await seedImport(db, { sheetHeader: header })
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([header, ...rows]),
      "text/csv"
    )
    await runToDone(imp.id)

    expect((await importRow(imp.id)).status).toBe("completed")
    const counts = await ledgerCounts(imp.id)
    expect(counts).toEqual({ done: 0, needs_review: 0, failed: 1 })
    expect((await importRow(imp.id)).row_count).toBe(1)
  })
})
