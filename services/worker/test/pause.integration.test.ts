/**
 * Per-provider Pause (GLOSSARY: Pause) — the 429 acceptance path driven
 * through the DB-contract seam with chaos on the stub provider (the only
 * injection point). A rate-limited provider engages a Pause honoring
 * Retry-After, the Import surfaces "Paused — resuming in X minutes", that
 * provider's Jobs stop being claimed while OTHER providers keep working,
 * and everything resumes automatically on schedule — no human action.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { importStreamKey } from "@workspace/pipeline"

import {
  claimJob,
  createProviderRegistry,
  createStubProvider,
  createWorker,
  defineHandlers,
  resolveConfig,
  type Provider,
  type ProviderEntry,
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

/** One fully-grounded row → one Product (identity: code, everything set). */
function groundedRow(sku: string): string[] {
  return [
    sku,
    `Gießkanne ${sku}`,
    "Brunner",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech.",
    "12,50",
    "rot",
  ]
}

/** A provider test double — entered through the PORT, never a handler mock. */
function createEchoProvider(): Provider {
  const usage = {
    providerId: "echo",
    model: "echo-v1",
    tokensIn: 1,
    tokensOut: 1,
  }
  return {
    id: "echo",
    async enrich(input) {
      const value = {
        title: `echo ${input.product.title}`,
        handle: `echo-${input.product.naturalKeyHash.slice(0, 8)}`,
        description: input.product.description ?? "echo description",
        category: input.product.category ?? "echo category",
        tags: [],
        attributes: { ...input.attributes },
        confidence: {
          title: 95,
          handle: 95,
          description: 95,
          category: 95,
          tags: 95,
          attributes: 95,
        },
        status: "ready" as const,
        claims: [],
        reviewReasons: [],
        sourceRows: [...input.sourceRows].sort((a, b) => a - b),
      }
      return { value, usage }
    },
    async translate(input) {
      return { value: { fields: { ...input.fields } }, usage }
    },
  }
}

interface WorkerDeps {
  workerId: string
  batchSize?: number
  entries: ProviderEntry[]
}

function fullPipelineWorker(options: WorkerDeps) {
  const registry = createProviderRegistry(options.entries)
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
      workerId: options.workerId,
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      batchSize: options.batchSize ?? 4,
    },
    planners: {
      clean: planCleanStage,
      group: planGroupStage,
      "match-media": (dbRef, target) =>
        planMatchMediaStage(dbRef, target, {
          batchSize: 1,
          providerForTier: (tier) => registry.providerIdForTier(tier),
        }),
      finalise: planFinaliseStage,
    },
  })
}

async function importStatus(importId: string): Promise<{
  status: string
  paused_until: string | null
  paused_provider_id: string | null
}> {
  const rows = (await db.db.execute(sql`
    SELECT status::text AS status, paused_until::text AS paused_until,
           paused_provider_id AS paused_provider_id
    FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{
    status: string
    paused_until: string | null
    paused_provider_id: string | null
  }>
  return rows[0]!
}

async function seedSheet(rows: string[][]): Promise<string> {
  const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...rows]),
    "text/csv"
  )
  return imp.id
}

async function pauseRows(): Promise<
  Array<{ provider_id: string; resume_at: string; reason: string }>
> {
  return (await db.db.execute(sql`
    SELECT provider_id, resume_at::text AS resume_at, reason FROM provider_pauses
  `)) as unknown as Array<{
    provider_id: string
    resume_at: string
    reason: string
  }>
}

async function jobStats(
  providerId: string,
  stage?: string
): Promise<{
  pending: number
  running: number
  completed: number
  attempts: number
}> {
  const stageFilter = stage ? sql` AND stage = ${stage}` : sql``
  const rows = (await db.db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'completed')::int AS completed,
      COALESCE(sum(attempts), 0)::int AS attempts
    FROM jobs WHERE provider_id = ${providerId}${stageFilter}
  `)) as unknown as Array<{
    pending: number
    running: number
    completed: number
    attempts: number
  }>
  return rows[0]!
}

describe("429 engages the per-provider Pause (EC-082/EC-083)", () => {
  it("pauses with a countdown, holds claims, and resumes automatically", async () => {
    // Six grounded products, one per enrich Batch: calls 1–3 succeed, call 4
    // is throttled (Retry-After 800ms), and the throttle lifts after that.
    const importId = await seedSheet([
      groundedRow("P-1"),
      groundedRow("P-2"),
      groundedRow("P-3"),
      groundedRow("P-4"),
      groundedRow("P-5"),
      groundedRow("P-6"),
    ])
    const worker = fullPipelineWorker({
      workerId: "w-pause-single",
      entries: [
        {
          provider: createStubProvider({
            rateLimitAfter: 3,
            rateLimitFor: 1,
            retryAfterMs: 800,
          }),
          concurrency: 4,
          tiers: ["fast", "strong"],
        },
      ],
    })
    worker.start()
    try {
      // The Pause engages and the Import surfaces it with a resume time.
      await waitFor(
        "import paused",
        async () => (await importStatus(importId)).status === "paused"
      )
      const pauses = await pauseRows()
      expect(pauses).toHaveLength(1)
      expect(pauses[0]!.provider_id).toBe("stub")
      const surfaced = await importStatus(importId)
      expect(surfaced.paused_provider_id).toBe("stub")
      expect(surfaced.paused_until).not.toBeNull()
      // Honors Retry-After: resume is ~800ms out, a real countdown.
      const resumeIn = new Date(surfaced.paused_until!).getTime() - Date.now()
      expect(resumeIn).toBeGreaterThan(0)
      expect(resumeIn).toBeLessThanOrEqual(800)

      // The `paused` event lands on the Import's stream (ioredis returns
      // each entry's fields as a flat [field, value, …] array).
      const entries = await cache.redis.xrange(
        importStreamKey(importId),
        "-",
        "+"
      )
      const pausedEvents = entries
        .map((entry) => {
          const fields = entry[1]
          const index = fields.findIndex((field) => field === "data")
          return index === -1 ? "{}" : (fields[index + 1] ?? "{}")
        })
        .map(
          (raw) =>
            JSON.parse(raw) as { type: string; data: { providerId?: string } }
        )
        .filter((event) => event.type === "paused")
      expect(pausedEvents).toHaveLength(1)
      expect(pausedEvents[0]!.data.providerId).toBe("stub")

      // That provider's Jobs stop being claimed while paused. The hold
      // window must elapse on the real clock: the loops poll Postgres on
      // real timers and the Pause is a real 800ms Retry-After — fake timers
      // cannot advance either. (Enrich-stage jobs: translate is still
      // stage-gated behind enrich and pends regardless. How many of the
      // in-flight jobs had already finished when the Pause flipped is a
      // Claims freeze once the Pause is committed AND the jobs already
      // in flight (claimed before the flip) have settled — a pause holds
      // claims, never executions. Settle first, then freeze-assert.
      await waitFor("no in-flight enrich jobs", async () => {
        const stats = await jobStats("stub", "enrich")
        return stats.running === 0
      })
      const duringPause = await jobStats("stub", "enrich")
      expect(duringPause.pending).toBeGreaterThan(0)
      const { promise: holdElapsed, resolve: holdDone } =
        Promise.withResolvers<void>()
      setTimeout(holdDone, 300)
      await holdElapsed
      const stillHeld = await jobStats("stub", "enrich")
      expect(stillHeld).toEqual(duringPause)

      // …and everything resumes automatically on schedule, no human action.
      await waitFor(
        "import completed after automatic resume",
        async () => (await importStatus(importId)).status === "completed",
        20_000
      )
      expect(await pauseRows()).toHaveLength(0)
      const cleared = await importStatus(importId)
      expect(cleared.paused_provider_id).toBeNull()
      expect(cleared.paused_until).toBeNull()
      const enrich = await jobStats("stub", "enrich")
      expect(enrich.completed).toBe(6)
      expect(enrich.pending).toBe(0)
    } finally {
      await worker.stop()
    }
  }, 30_000)
})

describe("Pause is per provider across all Imports", () => {
  it("holds the throttled provider's Jobs while other providers keep working", async () => {
    // Two fast-tier products (grounded) and two strong-tier products
    // (title-identity, nothing grounded) — four single-product Batches.
    const importId = await seedSheet([
      groundedRow("F-1"),
      groundedRow("F-2"),
      ["", "Mysteriöser Gegenstand", "", "", "", "9,90", ""],
      ["", "Kryptisches Bauteil", "", "", "", "19,90", ""],
    ])
    const worker = fullPipelineWorker({
      workerId: "w-pause-multi",
      entries: [
        {
          // The strong tier's provider throttles EVERY call (Retry-After 5s
          // — longer than the test, so only the automatic gate matters).
          provider: createStubProvider({
            rateLimitAfter: 0,
            retryAfterMs: 5_000,
          }),
          concurrency: 4,
          tiers: ["strong"],
        },
        { provider: createEchoProvider(), concurrency: 4, tiers: ["fast"] },
      ],
    })
    worker.start()
    try {
      // The healthy provider finishes its enrich Jobs while the stub is
      // paused (translate stays stage-gated behind the paused enrich).
      await waitFor(
        "echo enrich jobs all completed",
        async () => {
          const stats = await jobStats("echo", "enrich")
          return stats.completed === 2 && stats.pending === 0
        },
        15_000
      )
      const stubStats = await jobStats("stub", "enrich")
      expect(stubStats.completed).toBe(0)
      expect(stubStats.attempts).toBe(0) // 429 requeues refund the attempt
      expect(stubStats.pending).toBe(2)

      // Only the throttling provider is paused; the Import surfaces it.
      const pauses = await pauseRows()
      expect(pauses.map((row) => row.provider_id)).toEqual(["stub"])
      expect((await importStatus(importId)).status).toBe("paused")
      expect((await importStatus(importId)).paused_provider_id).toBe("stub")
    } finally {
      await worker.stop()
    }
  }, 30_000)
})

describe("claim gate holds paused-provider Jobs", () => {
  it("skips Jobs of a paused provider and Jobs not yet available", async () => {
    const config = resolveConfig({ workerId: "w-gate" })
    const imp = await seedImport(db, { status: "running", stage: "enrich" })
    const insertJob = async (
      batchKey: string,
      providerId: string | null
    ): Promise<string> => {
      const rows = (await db.db.execute(sql`
        INSERT INTO jobs (store_id, import_id, stage, batch_key, provider_id)
        VALUES (${imp.storeId}, ${imp.id}, 'enrich', ${batchKey}, ${providerId})
        RETURNING id
      `)) as unknown as Array<{ id: string }>
      return rows[0]!.id
    }
    const stubJob = await insertJob("products-000001-000001", "stub")
    const freeJob = await insertJob("products-000002-000002", null)

    // Paused: only the provider-less Job is claimable.
    await db.db.execute(sql`
      INSERT INTO provider_pauses (store_id, provider_id, reason, resume_at)
      VALUES (${imp.storeId}, 'stub', '429', now() + interval '1 hour')
    `)
    const claimedDuringPause = await claimJob(db.db, config)
    expect(claimedDuringPause?.id).toBe(freeJob)
    expect(claimedDuringPause?.providerId).toBeNull()
    expect(await claimJob(db.db, config)).toBeNull()

    // Scheduled requeue (backoff/Pause delay): not claimable early.
    await db.db.execute(sql`
      UPDATE jobs SET available_at = now() + interval '1 hour' WHERE id = ${stubJob}
    `)
    await db.db.execute(sql`DELETE FROM provider_pauses`)
    expect(await claimJob(db.db, config)).toBeNull()

    // Once available (and unpaused), the Job claims with its tier attached.
    await db.db.execute(sql`
      UPDATE jobs SET available_at = now() - interval '1 second' WHERE id = ${stubJob}
    `)
    const claimed = await claimJob(db.db, config)
    expect(claimed?.id).toBe(stubJob)
  })
})
