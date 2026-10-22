/**
 * Idempotency proof (ADR-0003, EC-121) — the same enrich Job claimed and
 * executed TWICE converges: one enrichment per Product, one translation per
 * (Product, locale, field), zero duplicate Products — while the usage rows
 * honestly show both calls really happened (at-least-once is paid twice,
 * never written twice).
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
    sql`TRUNCATE jobs, imports, sheet_rows, import_files, provider_pauses, job_retries CASCADE`
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
    "Watering pot 5L",
    "Brunner",
    "Garden > Watering",
    "Durable steel watering pot for indoor and outdoor use.",
    "12,50",
    "rot",
  ],
  [
    "TP-100-G",
    "Watering pot 5L",
    "Brunner",
    "Garden > Watering",
    "Durable steel watering pot for indoor and outdoor use.",
    "12,50",
    "grün",
  ],
]

async function seedSheet(): Promise<string> {
  const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
    "text/csv"
  )
  return imp.id
}

function idempotentWorker(workerId: string) {
  const registry = createProviderRegistry([
    {
      provider: createStubProvider(),
      concurrency: 4,
      tiers: ["fast", "strong"],
    },
  ])
  return createWorker({
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
}

describe("at-least-once idempotency (ADR-0003)", () => {
  it("converges to one enrichment and translation set when the same Job runs twice", async () => {
    const importId = await seedSheet()
    const worker = idempotentWorker("w-idem")
    worker.start()
    try {
      // ONE enrich Job (both rows group into one Product, one Batch) —
      // claimed once and completed by the live pipeline.
      await waitFor(
        "enrich job completed once",
        async () => {
          const rows = (await db.db.execute(sql`
          SELECT status::text AS status, attempts FROM jobs
          WHERE import_id = ${importId} AND stage = 'enrich'
        `)) as unknown as Array<{ status: string; attempts: number }>
          return (
            rows.length === 1 &&
            rows[0]!.status === "completed" &&
            rows[0]!.attempts === 1
          )
        },
        20_000
      )

      // Redeliver the very same Job: back to pending, lease gone — the
      // exact shape a crashed worker's reclaimed Job arrives in.
      await db.db.execute(sql`
        UPDATE jobs SET status = 'pending', lease_owner = NULL,
               lease_expires_at = NULL
        WHERE import_id = ${importId} AND stage = 'enrich'
      `)
      await waitFor(
        "enrich job completed again",
        async () => {
          const rows = (await db.db.execute(sql`
          SELECT status::text AS status, attempts FROM jobs
          WHERE import_id = ${importId} AND stage = 'enrich'
        `)) as unknown as Array<{ status: string; attempts: number }>
          return rows[0]!.status === "completed" && rows[0]!.attempts === 2
        },
        20_000
      )
    } finally {
      await worker.stop()
    }

    // Convergence: ONE enrichment for the ONE Product — the second
    // execution upserted instead of appending (ADR-0003).
    const enrichments = (await db.db.execute(sql`
      SELECT count(*)::int AS n, count(DISTINCT product_id)::int AS distinct_products
      FROM product_enrichments WHERE import_id = ${importId}
    `)) as unknown as Array<{ n: number; distinct_products: number }>
    expect(enrichments[0]!.n).toBe(1)
    expect(enrichments[0]!.distinct_products).toBe(1)

    // ONE translation per (Product, locale, field) — duplicates impossible.
    const translations = (await db.db.execute(sql`
      SELECT count(*)::int AS n,
             count(DISTINCT (product_id, locale, field))::int AS distinct_sets
      FROM product_translations WHERE import_id = ${importId}
    `)) as unknown as Array<{ n: number; distinct_sets: number }>
    expect(translations[0]!.n).toBe(translations[0]!.distinct_sets)
    expect(translations[0]!.n).toBeGreaterThan(0)

    // Zero duplicate Products — scoped Natural Key uniqueness holds.
    const products = (await db.db.execute(sql`
      SELECT count(*)::int AS n,
             count(DISTINCT natural_key_hash)::int AS distinct_keys
      FROM products WHERE import_id = ${importId}
    `)) as unknown as Array<{ n: number; distinct_keys: number }>
    expect(products[0]!.n).toBe(1)
    expect(products[0]!.distinct_keys).toBe(1)

    // …and the ledger still adds up to the sheet, with usage honestly
    // showing BOTH executions (at-least-once is priced twice, written once).
    const accounting = (await db.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM row_ledger WHERE import_id = ${importId}) AS ledger,
        (SELECT count(*)::int FROM provider_usage WHERE import_id = ${importId}
           AND operation = 'enrich') AS enrich_calls
    `)) as unknown as Array<{ ledger: number; enrich_calls: number }>
    expect(accounting[0]!.ledger).toBe(2)
    expect(accounting[0]!.enrich_calls).toBe(2) // one call per execution
  }, 40_000)
})
