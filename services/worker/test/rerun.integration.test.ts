/**
 * Re-run enrichment — the DB-contract seam (ADR-0004).
 *
 * The app writes a `reruns` fact (the chosen Products); the Worker's Sweeper
 * adopts it by requeuing the enrich Jobs whose deterministic Batches cover
 * those Products with reset attempts, and the real handlers re-enrich them
 * (new usage rows, refreshed enrichment). Tests write the fact the way the
 * dashboard's route does and observe Postgres only — no worker internals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Cache } from "@workspace/cache"
import type { Db } from "@workspace/db"
import type { Storage } from "@workspace/storage"

import {
  adoptReruns,
  createWorker,
  defineHandlers,
  keyHash,
  planCleanStage,
  planFinaliseStage,
  planGroupStage,
  planMatchMediaStage,
  createIntakeHandler,
  createCleanHandler,
  createGroupHandler,
  createMatchMediaHandler,
  createEnrichHandler,
  createTranslateHandler,
  createFinaliseHandler,
  createProviderRegistry,
  createStubProvider,
} from "../src/index.js"
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
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files, cleaned_rows, clean_plans CASCADE`
  )
})

afterAll(async () => {
  await cache.close()
  await db.close()
  await dropTestDatabase()
})

async function seedProduct(
  importId: string,
  naturalKey: string
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO products (
      id, store_id, import_id, family_key, identity_kind, natural_key,
      natural_key_hash, title
    ) VALUES (
      ${id}, 'test-store', ${importId},
      (SELECT family_key FROM imports WHERE id = ${importId}),
      'code', ${naturalKey},
      ${keyHash(naturalKey)}, ${naturalKey}
    )
  `)
  return id
}

async function seedEnrichJob(
  importId: string,
  batchKey: string,
  status: "completed" | "failed" | "pending",
  attempts: number
): Promise<string> {
  const rows = (await db.db.execute(sql`
    INSERT INTO jobs (store_id, import_id, stage, batch_key, status, attempts, provider_id, routing_tier)
    VALUES ('test-store', ${importId}, 'enrich', ${batchKey}, ${status}, ${attempts}, 'stub', 'fast')
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

/** Write the fact exactly the way the dashboard's reruns route does. */
async function seedRerunFact(
  importId: string,
  productIds: string[]
): Promise<string> {
  const rows = (await db.db.execute(sql`
    INSERT INTO reruns (store_id, import_id, stage, product_ids)
    VALUES ('test-store', ${importId}, 'enrich', ARRAY[${sql.join(
      productIds.map((id) => sql`${id}::uuid`),
      sql`, `
    )}]::uuid[])
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

interface JobRow {
  id: string
  stage: string
  batch_key: string
  status: string
  attempts: number
}

async function jobRows(importId: string): Promise<JobRow[]> {
  return (await db.db.execute(sql`
    SELECT id, stage, batch_key, status, attempts
    FROM jobs WHERE import_id = ${importId}
    ORDER BY stage, batch_key
  `)) as unknown as JobRow[]
}

async function rerunFacts(importId: string): Promise<Array<{ id: string }>> {
  return (await db.db.execute(sql`
    SELECT id FROM reruns WHERE import_id = ${importId}
  `)) as unknown as Array<{ id: string }>
}

/** Product ids of one Import in the deterministic batch order. */
async function productsInBatchOrder(importId: string): Promise<string[]> {
  return (
    (await db.db.execute(sql`
      SELECT id FROM products WHERE import_id = ${importId}
      ORDER BY natural_key_hash
    `)) as unknown as Array<{ id: string }>
  ).map((row) => row.id)
}

describe("adoptReruns (sweeper adoption of Re-run facts)", () => {
  it("requeues the completed enrich Jobs covering the chosen Products with reset attempts", async () => {
    const imp = await seedImport(db, { status: "completed", stage: "finalise" })
    await seedProduct(imp.id, "sku:a-1")
    await seedProduct(imp.id, "sku:a-2")
    await seedProduct(imp.id, "sku:a-3")
    const jobs = await Promise.all([
      seedEnrichJob(imp.id, "products-000001-000002", "completed", 3),
      seedEnrichJob(imp.id, "products-000003-000003", "completed", 1),
    ])
    const ordered = await productsInBatchOrder(imp.id)
    expect(ordered).toHaveLength(3)
    // Re-run the two products of the FIRST batch (ordinals 1–2).
    await seedRerunFact(imp.id, [ordered[0]!, ordered[1]!])

    const adopted = await adoptReruns(db.db)
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.importId).toBe(imp.id)
    expect(adopted[0]!.requeuedJobIds).toHaveLength(1)
    expect(adopted[0]!.requeuedJobIds).toContain(jobs[0]!)

    const after = await jobRows(imp.id)
    const first = after.find(
      (row) => row.batch_key === "products-000001-000002"
    )!
    expect(first.status).toBe("pending")
    expect(first.attempts).toBe(0) // reset — a fresh lease on life
    const second = after.find(
      (row) => row.batch_key === "products-000003-000003"
    )!
    expect(second.status).toBe("completed") // untouched
    expect(second.attempts).toBe(1)

    expect(await rerunFacts(imp.id)).toHaveLength(0) // adopted = deleted
  })

  it("is idempotent: a second adoption sweep requeues nothing", async () => {
    const imp = await seedImport(db, { status: "completed", stage: "finalise" })
    const product = await seedProduct(imp.id, "sku:b-1")
    await seedEnrichJob(imp.id, "products-000001-000001", "completed", 2)
    await seedRerunFact(imp.id, [product])

    expect(await adoptReruns(db.db)).toHaveLength(1)
    // The Job is now pending; adopting again must not touch it…
    expect(await adoptReruns(db.db)).toHaveLength(0)
    const jobs = await jobRows(imp.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ status: "pending", attempts: 0 })
  })

  it("requeues a poison-failed enrich Job and leaves other stages and imports alone", async () => {
    const imp = await seedImport(db, { status: "completed", stage: "finalise" })
    const product = await seedProduct(imp.id, "sku:c-1")
    const other = await seedImport(db, {
      status: "completed",
      stage: "finalise",
    })
    await seedProduct(other.id, "sku:c-1")
    const failedJob = await seedEnrichJob(
      imp.id,
      "products-000001-000001",
      "failed",
      5
    )
    await db.db.execute(sql`
      INSERT INTO jobs (store_id, import_id, stage, batch_key, status, attempts)
      VALUES ('test-store', ${imp.id}, 'translate', 'products-000001-000001:de', 'failed', 5)
    `)
    await seedRerunFact(imp.id, [product])

    const adopted = await adoptReruns(db.db)
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.requeuedJobIds).toEqual([failedJob])

    const jobs = await jobRows(imp.id)
    const enrich = jobs.find((row) => row.stage === "enrich")!
    expect(enrich).toMatchObject({ status: "pending", attempts: 0 })
    const translate = jobs.find((row) => row.stage === "translate")!
    expect(translate).toMatchObject({ status: "failed", attempts: 5 })
    expect(await jobRows(other.id)).toHaveLength(0) // other imports untouched
  })

  it("adopts a fact with no matching terminal Jobs as a harmless no-op", async () => {
    const imp = await seedImport(db, { status: "completed", stage: "finalise" })
    const product = await seedProduct(imp.id, "sku:d-1")
    await seedEnrichJob(imp.id, "products-000001-000001", "pending", 0)
    await seedRerunFact(imp.id, [product])

    const adopted = await adoptReruns(db.db)
    expect(adopted).toHaveLength(1)
    expect(adopted[0]!.requeuedJobIds).toEqual([])
    expect(await rerunFacts(imp.id)).toHaveLength(0)
    expect((await jobRows(imp.id))[0]).toMatchObject({
      status: "pending",
      attempts: 0,
    })
  })
})

/**
 * The full pipeline contract: a completed Import, a Re-run fact written the
 * way the dashboard writes it, and the real Worker loops — the enrichment
 * of the chosen Products runs again (usage rows grow, enrichment refreshes)
 * and the fact is consumed.
 */
describe("re-run enrichment end-to-end", () => {
  const SHEET_HEADER = ["SKU", "Title", "Description"]
  const SHEET_ROWS = [
    ["TP-1", "Watering can 5L", "Durable steel body, 5 l."],
    ["TP-2", "Flower pot M", "Glazed clay, 20 cm."],
    ["TP-3", "Pruning shears", "Bypass blade, spring-loaded."],
    ["TP-4", "Plant labels", "Weatherproof bamboo tags."],
  ]

  function demoWorker(workerId: string) {
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
        heartbeatIntervalMs: 100,
        leaseTtlMs: 5_000,
        batchSize: 5,
      },
      planners: {
        clean: planCleanStage,
        group: planGroupStage,
        "match-media": (planningDb, target) =>
          planMatchMediaStage(planningDb, target, { batchSize: 2 }),
        finalise: planFinaliseStage,
      },
    })
  }

  async function runToCompleted(importId: string): Promise<void> {
    const worker = demoWorker(`w-rerun-${crypto.randomUUID().slice(0, 8)}`)
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

  it("re-enriches the selected Products when the Worker adopts the fact", async () => {
    const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
    await db.db.execute(sql`
      INSERT INTO import_files (store_id, import_id, kind, object_key, filename, content_type)
      VALUES (
        'test-store', ${imp.id}, 'sheet', ${imp.sheetObjectKey}, 'sheet.csv', 'text/csv'
      )
    `)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
      "text/csv"
    )

    await runToCompleted(imp.id)

    const enrichJobs = (await db.db.execute(sql`
      SELECT id, batch_key FROM jobs
      WHERE import_id = ${imp.id} AND stage = 'enrich' ORDER BY batch_key
    `)) as unknown as Array<{ id: string; batch_key: string }>
    expect(enrichJobs).toHaveLength(2) // 4 products / batchSize 2

    const usageBefore = (
      (await db.db.execute(sql`
        SELECT count(*)::int AS count FROM provider_usage
        WHERE import_id = ${imp.id} AND operation = 'enrich'
      `)) as unknown as Array<{ count: number }>
    )[0]!.count
    expect(usageBefore).toBe(4) // one synthetic call per product

    const enrichmentsBefore = (await db.db.execute(sql`
      SELECT product_id, updated_at FROM product_enrichments
      WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ product_id: string; updated_at: string }>

    // The dashboard writes the fact for the FIRST batch's products — the
    // same rows a POST /api/imports/:id/reruns creates.
    const ordered = await productsInBatchOrder(imp.id)
    const firstBatch = [ordered[0]!, ordered[1]!]
    await seedRerunFact(imp.id, firstBatch)

    // Real loops: the sweeper adopts the fact, the Job requeues and runs.
    const worker = demoWorker(`w-rerun2-${crypto.randomUUID().slice(0, 8)}`)
    worker.start()
    try {
      await waitFor(
        "rerun fact adopted and enrich job re-run",
        async () => {
          if ((await rerunFacts(imp.id)).length > 0) return false
          const jobs = (await db.db.execute(sql`
            SELECT status FROM jobs
            WHERE import_id = ${imp.id} AND stage = 'enrich'
          `)) as unknown as Array<{ status: string }>
          return jobs.every((row) => row.status === "completed")
        },
        30_000
      )
    } finally {
      await worker.stop()
    }

    const usageAfter = (
      (await db.db.execute(sql`
        SELECT count(*)::int AS count FROM provider_usage
        WHERE import_id = ${imp.id} AND operation = 'enrich'
      `)) as unknown as Array<{ count: number }>
    )[0]!.count
    expect(usageAfter).toBe(usageBefore + 2) // exactly the re-run products

    // The re-run products' enrichment rows were refreshed (upserted).
    const enrichmentsAfter = (await db.db.execute(sql`
      SELECT product_id, updated_at FROM product_enrichments
      WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ product_id: string; updated_at: string }>
    expect(enrichmentsAfter).toHaveLength(enrichmentsBefore.length)
    const beforeByProduct = new Map(
      enrichmentsBefore.map((row) => [row.product_id, row.updated_at])
    )
    const refreshed = enrichmentsAfter.filter(
      (row) => beforeByProduct.get(row.product_id) !== row.updated_at
    )
    expect(refreshed.map((row) => row.product_id).sort()).toEqual(
      [...firstBatch].sort()
    )

    expect(await rerunFacts(imp.id)).toHaveLength(0)
  })
})
