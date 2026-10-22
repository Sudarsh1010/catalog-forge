/**
 * The poison path (ADR-0003, EC-122) driven through the DB-contract seam
 * with chaos on the stub provider: a permanently failing enrich Job burns
 * its five attempts and terminates as Failed-with-reason IN the Row Ledger
 * (the Import stays retryable, not stranded), the dashboard's retry fact
 * requeues it with reset attempts, and the retried run heals its rows and
 * carries the Import to `completed`. Plus: exponential backoff with jitter
 * on server errors (EC-082/EC-083) — observable purely as Job state.
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
  ProviderError,
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
import { failBatchRows } from "../src/poison.js"
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
    "P-1",
    "Gießkanne rund",
    "Brunner",
    "Garten > Bewässerung",
    "Robuste Gießkanne aus Stahlblech.",
    "12,50",
    "rot",
  ],
  [
    "Q-2",
    "Schaufel gerade",
    "Brunner",
    "Garten > Werkzeug",
    "Stabile Schaufel mit Eschengriff.",
    "4,90",
    "",
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

function pipelineWorker(
  workerId: string,
  options: {
    /** Chaos flags for the stub serving every tier. */
    chaos?: Parameters<typeof createStubProvider>[0]
    backoffBaseMs?: number
    maxAttempts?: number
    jitter?: () => number
  } = {}
) {
  const registry = createProviderRegistry([
    {
      provider: createStubProvider(options.chaos),
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
    poisonHandlers: { enrich: failBatchRows, translate: failBatchRows },
    config: {
      workerId,
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      batchSize: 4,
      backoffBaseMs: options.backoffBaseMs ?? 1,
      maxAttempts: options.maxAttempts ?? 5,
      ...(options.jitter ? { jitter: options.jitter } : {}),
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

interface LedgerRow {
  row_index: number
  state: string
  failure_reason: string | null
}

async function ledgerRows(importId: string): Promise<LedgerRow[]> {
  return (await db.db.execute(sql`
    SELECT row_index, state::text AS state, failure_reason
    FROM row_ledger WHERE import_id = ${importId} ORDER BY row_index
  `)) as unknown as LedgerRow[]
}

async function enrichJobs(importId: string): Promise<
  Array<{
    id: string
    status: string
    attempts: number
    last_error: string | null
  }>
> {
  return (await db.db.execute(sql`
    SELECT id, status::text AS status, attempts, last_error
    FROM jobs WHERE import_id = ${importId} AND stage = 'enrich'
    ORDER BY batch_key
  `)) as unknown as Array<{
    id: string
    status: string
    attempts: number
    last_error: string | null
  }>
}

describe("poison Jobs: Failed-with-reason in the ledger, retryable", () => {
  it("quarantines rows after 5 attempts, then a retry fact heals and completes", async () => {
    const importId = await seedSheet()

    // Run 1: every provider call fails with a 5xx — the poison path.
    const failing = pipelineWorker("w-poison-run", {
      chaos: { failureRate: 1 },
    })
    failing.start()
    try {
      await waitFor(
        "enrich jobs terminally failed",
        async () => {
          const jobs = await enrichJobs(importId)
          return (
            jobs.length === 2 && jobs.every((job) => job.status === "failed")
          )
        },
        20_000
      )
    } finally {
      await failing.stop()
    }

    // Five attempts each; the ledger keeps its terminal verdicts — the
    // rows are Done (grouped cleanly), and a poisoned Job never overwrites
    // terminal Row Ledger states (done/needs_review reasons survive).
    const failed = await enrichJobs(importId)
    for (const job of failed) {
      expect(job.attempts).toBe(5)
      expect(job.last_error).toContain("server_error")
    }
    const quarantined = await ledgerRows(importId)
    expect(quarantined).toHaveLength(2)
    for (const row of quarantined) {
      expect(row.state).toBe("done")
      expect(row.failure_reason).toBeNull()
    }
    // The Import is NOT stranded mid-stage: it waits, retryable.
    const stalled = (await db.db.execute(sql`
      SELECT status::text AS status, stage FROM imports WHERE id = ${importId}
    `)) as unknown as Array<{ status: string; stage: string }>
    expect(stalled[0]!.status).toBe("running")
    expect(stalled[0]!.stage).toBe("enrich")

    // Run 2: the dashboard retries both Jobs (the app writes the domain
    // fact — the HTTP route is a thin wrapper around exactly this insert).
    const retryFact = await db.db.execute(sql`
      INSERT INTO job_retries (store_id, import_id, job_id)
      SELECT store_id, import_id, id FROM jobs
      WHERE import_id = ${importId} AND stage = 'enrich' AND status = 'failed'
      RETURNING job_id
    `)
    expect((retryFact as unknown as Array<unknown>).length).toBe(2)

    const healthy = pipelineWorker("w-poison-retry")
    healthy.start()
    try {
      // The sweeper adopts the fact: reset attempts, requeue, succeed, heal.
      await waitFor(
        "retry completed the import",
        async () => {
          const rows = (await db.db.execute(sql`
            SELECT status::text AS status FROM imports WHERE id = ${importId}
          `)) as unknown as Array<{ status: string }>
          return rows[0]!.status === "completed"
        },
        20_000
      )
    } finally {
      await healthy.stop()
    }

    // The retried Jobs ran ONCE from a clean slate and their rows healed.
    const retried = await enrichJobs(importId)
    for (const job of retried) {
      expect(job.status).toBe("completed")
      expect(job.attempts).toBe(1) // reset to 0 by adoption, then claimed once
    }
    const healed = await ledgerRows(importId)
    expect(healed.map((row) => row.state)).toEqual(["done", "done"])
    const retryQueue = (await db.db.execute(sql`
      SELECT count(*)::int AS n FROM job_retries
    `)) as unknown as Array<{ n: number }>
    expect(retryQueue[0]!.n).toBe(0) // adopted requests are consumed
  }, 40_000)

  it("requeues server errors with exponential backoff and jitter, counting attempts", async () => {
    const imp = await seedImport(db, { status: "running", stage: "enrich" })
    // One provider-stamped enrich Job whose handler always 5xxs.
    const jobRow = (await db.db.execute(sql`
      INSERT INTO jobs (store_id, import_id, stage, batch_key, provider_id, routing_tier, max_attempts)
      VALUES (${imp.storeId}, ${imp.id}, 'enrich', 'products-000001-000001', 'stub', 'fast', 3)
      RETURNING id
    `)) as unknown as Array<{ id: string }>
    const jobId = jobRow[0]!.id
    const worker = createWorker({
      db,
      handlers: defineHandlers({
        enrich: async () => {
          throw new ProviderError({ class: "server_error", status: 503 })
        },
      }),
      config: {
        workerId: "w-backoff",
        claimIntervalMs: 10,
        sweepIntervalMs: 25,
        backoffBaseMs: 100,
        backoffMaxMs: 10_000,
        jitter: () => 0.5, // pinned: delay = base * 2^(n-1) + 0.5 * base
        maxAttempts: 3,
      },
    })
    worker.start()
    try {
      // Attempt 1 requeues with 100 * 2^0 + 50 = 150ms of backoff.
      await waitFor("attempt 1 requeued with backoff", async () => {
        const rows = (await db.db.execute(sql`
          SELECT attempts, available_at FROM jobs WHERE id = ${jobId}
        `)) as unknown as Array<{
          attempts: number
          available_at: string | null
        }>
        return rows[0]!.attempts === 1 && rows[0]!.available_at !== null
      })
      const first = (await db.db.execute(sql`
        SELECT available_at, updated_at FROM jobs WHERE id = ${jobId}
      `)) as unknown as Array<{ available_at: string; updated_at: string }>
      const delayMs =
        new Date(first[0]!.available_at).getTime() -
        new Date(first[0]!.updated_at).getTime()
      expect(delayMs).toBeGreaterThanOrEqual(140)
      expect(delayMs).toBeLessThanOrEqual(400)

      // Attempts count: three strikes, then terminal Failed.
      await waitFor("job terminally failed after 3 attempts", async () => {
        const rows = (await db.db.execute(sql`
          SELECT status::text AS status, attempts FROM jobs WHERE id = ${jobId}
        `)) as unknown as Array<{ status: string; attempts: number }>
        return rows[0]!.status === "failed"
      })
      const terminal = (await db.db.execute(sql`
        SELECT attempts, last_error FROM jobs WHERE id = ${jobId}
      `)) as unknown as Array<{ attempts: number; last_error: string | null }>
      expect(terminal[0]!.attempts).toBe(3)
      expect(terminal[0]!.last_error).toContain("server_error")
    } finally {
      await worker.stop()
    }
  }, 20_000)

  it("never overwrites terminal ledger rows (needs_review survives a poison)", async () => {
    const imp = await seedImport(db, { status: "running", stage: "enrich" })
    // One Product covering Batch products-000001-000001, with one ledger row
    // already terminal Needs Review and one Done — a later Job failure must
    // leave both verdicts (and the Needs Review reason) intact.
    const productId = crypto.randomUUID()
    await db.db.execute(sql`
      INSERT INTO products (id, store_id, import_id, family_key, identity_kind,
                            natural_key, natural_key_hash, title)
      VALUES (${productId}, ${imp.storeId}, ${imp.id},
              (SELECT family_key FROM imports WHERE id = ${imp.id}),
              'code', 'sku:t-1', ${productId}, 'Test 1')
    `)
    for (const [rowIndex, state, reason] of [
      [1, "needs_review", "Variant price conflicts across rows (EC-021)"],
      [2, "done", null],
    ] as Array<[number, string, string | null]>) {
      await db.db.execute(sql`
        INSERT INTO row_ledger (store_id, import_id, row_index, state, product_id, failure_reason)
        VALUES (${imp.storeId}, ${imp.id}, ${rowIndex}, ${state}::row_ledger_state,
                ${productId}, ${reason})
      `)
    }

    const quarantined = await failBatchRows(
      db.db,
      {
        storeId: imp.storeId,
        importId: imp.id,
        stage: "enrich",
        batchKey: "products-000001-000001",
        attempts: 5,
      },
      "provider gave up"
    )
    expect(quarantined).toBe(0) // nothing non-terminal to quarantine

    const rows = (await db.db.execute(sql`
      SELECT row_index, state::text AS state, failure_reason
      FROM row_ledger WHERE import_id = ${imp.id} ORDER BY row_index
    `)) as unknown as Array<{
      row_index: number
      state: string
      failure_reason: string | null
    }>
    expect(rows).toEqual([
      {
        row_index: 1,
        state: "needs_review",
        failure_reason: "Variant price conflicts across rows (EC-021)",
      },
      { row_index: 2, state: "done", failure_reason: null },
    ])
  })
})
