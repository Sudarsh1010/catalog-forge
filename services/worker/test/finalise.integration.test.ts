/**
 * finalise Stage integration tests — the DB-contract seam.
 *
 * Finalise is the one-Job-per-Import barrier that closes the loop: it
 * reconciles the Row Ledger so Done + Needs Review + Failed equals the
 * sheet total (assert-and-repair from ledger state; a mismatch is a LOUD
 * failure, never silent), flips the Import to `completed`, and publishes
 * `import_done`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { importStreamKey } from "@workspace/pipeline"

import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import { createEnrichHandler } from "../src/enrich/handler.js"
import { createTranslateHandler } from "../src/translate/handler.js"
import { createFinaliseHandler } from "../src/finalise/handler.js"
import { planFinaliseStage } from "../src/finalise/plan.js"
import {
  createWorker,
  createProviderRegistry,
  createStubProvider,
  defineHandlers,
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
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files CASCADE`
  )
})

afterAll(async () => {
  await cache.close()
  await db.close()
  await dropTestDatabase()
})

const SHEET_HEADER = ["SKU", "Title", "Category", "Description", "Price"]
const SHEET_ROWS = [
  [
    "TP-100",
    "Watering can 5L",
    "Garden > Watering",
    "Durable steel body.",
    "12.50",
  ],
  ["TP-101", "Garden shovel", "Garden > Tools", "Sturdy shovel.", "4.90"],
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

function tailRegistry() {
  return createProviderRegistry([
    {
      provider: createStubProvider(),
      concurrency: 4,
      tiers: ["fast", "strong"],
    },
  ])
}

/**
 * Real pipeline up to the finalise barrier: resolves when the Import has
 * ENTERED `finalise` (every translate Batch done) with no tail work left.
 * The finalise Job is planned separately so tests can sabotage ledger
 * state in between.
 */
async function runToFinaliseStage(importId: string): Promise<void> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      intake: createIntakeHandler({ storage, cache }),
      clean: createCleanHandler(),
      group: createGroupHandler(),
      "match-media": createMatchMediaHandler(),
      enrich: createEnrichHandler({ registry: tailRegistry() }),
      translate: createTranslateHandler({ registry: tailRegistry() }),
    }),
    cache,
    config: {
      workerId: `w-pre-${crypto.randomUUID().slice(0, 8)}`,
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
      "import entered finalise with no tail work left",
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

/** Plan the barrier Job and run a finalise-only worker until it settles. */
async function runFinaliseJob(importId: string): Promise<void> {
  await planFinaliseStage(db.db, { importId, storeId: "test-store" })
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      finalise: createFinaliseHandler({ cache }),
    }),
    cache,
    config: {
      workerId: `w-fin-${crypto.randomUUID().slice(0, 8)}`,
      claimIntervalMs: 10,
      batchSize: 10,
    },
  })
  worker.start()
  try {
    await waitFor(
      "finalise job settled",
      async () => {
        const rows = (await db.db.execute(sql`
          SELECT status FROM jobs
          WHERE import_id = ${importId} AND stage = 'finalise'
        `)) as unknown as Array<{ status: string }>
        return (
          rows.length === 1 &&
          (rows[0]!.status === "completed" || rows[0]!.status === "failed")
        )
      },
      20_000
    )
  } finally {
    await worker.stop()
  }
}

async function runToCompletion(importId: string): Promise<void> {
  await runToFinaliseStage(importId)
  await runFinaliseJob(importId)
  await waitFor(
    "import completed",
    async () => {
      const rows = (await db.db.execute(sql`
        SELECT status FROM imports WHERE id = ${importId}
      `)) as unknown as Array<{ status: string }>
      return rows[0]?.status === "completed"
    },
    10_000
  )
}

interface LedgerCounts {
  done: number
  needs_review: number
  failed: number
}

async function ledgerCounts(importId: string): Promise<LedgerCounts> {
  const rows = (await db.db.execute(sql`
    SELECT state::text AS state, count(*)::int AS count
    FROM row_ledger WHERE import_id = ${importId} GROUP BY state
  `)) as unknown as Array<{ state: string; count: number }>
  const counts: LedgerCounts = { done: 0, needs_review: 0, failed: 0 }
  for (const row of rows) {
    counts[row.state as keyof LedgerCounts] = row.count
  }
  return counts
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

async function eventTypes(importId: string): Promise<string[]> {
  const entries = await cache.redis.xrange(importStreamKey(importId), "-", "+")
  return entries.map((entry) => {
    const fields = entry[1]
    const index = fields.findIndex((field) => field === "type")
    return fields[index + 1] ?? ""
  })
}

describe("finalise Stage — the loop closes", () => {
  it("reconciles the ledger to the sheet total, completes the Import, and publishes import_done", async () => {
    const imp = await seedUpload()
    await runToCompletion(imp.id)

    const row = await importRow(imp.id)
    expect(row.status).toBe("completed")
    expect(row.stage).toBe("finalise")
    expect(row.row_count).toBe(SHEET_ROWS.length)

    // The counts add up to the sheet — by ledger, never by job bookkeeping.
    const counts = await ledgerCounts(imp.id)
    expect(counts.done + counts.needs_review + counts.failed).toBe(
      SHEET_ROWS.length
    )
    expect(counts.failed).toBe(0)

    const types = await eventTypes(imp.id)
    expect(types).toContain("import_done")
    // The finalise Job's own job_completed lands after the handler published
    // the completion fact — import_done exists exactly once, before it.
    expect(types.filter((type) => type === "import_done")).toHaveLength(1)
  })

  it("repairs Sheet Rows that never reached a terminal state as Failed with a reason (EC-126)", async () => {
    const imp = await seedUpload()
    await runToFinaliseStage(imp.id)
    // sabotage: one ledger row vanishes after the pipeline landed it — a
    // stranded row the finalise barrier must catch and account for.
    await db.db.execute(sql`
      DELETE FROM row_ledger WHERE import_id = ${imp.id} AND row_index = 2
    `)
    await runFinaliseJob(imp.id)

    const counts = await ledgerCounts(imp.id)
    expect(counts.done + counts.needs_review + counts.failed).toBe(
      SHEET_ROWS.length
    )
    expect(counts.failed).toBe(1)
    const repaired = (await db.db.execute(sql`
      SELECT state::text AS state, failure_reason FROM row_ledger
      WHERE import_id = ${imp.id} AND row_index = 2
    `)) as unknown as Array<{ state: string; failure_reason: string | null }>
    expect(repaired[0]!.state).toBe("failed")
    expect(repaired[0]!.failure_reason).toMatch(
      /never reached a terminal state/i
    )
  })

  it("fails loudly — and stays incomplete — when the ledger cannot add up", async () => {
    const imp = await seedUpload()
    await runToFinaliseStage(imp.id)
    // sabotage: the sheet grew behind finalise's back — a contract
    // violation no repair may paper over.
    await db.db.execute(sql`
      UPDATE imports SET row_count = ${SHEET_ROWS.length + 5} WHERE id = ${imp.id}
    `)
    await runFinaliseJob(imp.id)

    const job = (await db.db.execute(sql`
      SELECT status, last_error FROM jobs
      WHERE import_id = ${imp.id} AND stage = 'finalise'
    `)) as unknown as Array<{ status: string; last_error: string | null }>
    expect(job[0]!.status).toBe("failed")
    expect(job[0]!.last_error).toMatch(/add up|ledger/i)

    // Loud, not silent: the Import never completed, nothing was published.
    const row = await importRow(imp.id)
    expect(row.status).toBe("running")
    const types = await eventTypes(imp.id)
    expect(types).not.toContain("import_done")
  })

  it("is idempotent: a redelivered finalise Job converges without duplicating import_done (ADR-0003)", async () => {
    const imp = await seedUpload()
    await runToCompletion(imp.id)

    // Redeliver: crash-after-write shape — the guarded completion is a
    // no-op and the event is not re-published.
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0, lease_owner = NULL,
        lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'finalise'
    `)
    await runFinaliseJob(imp.id)

    const row = await importRow(imp.id)
    expect(row.status).toBe("completed")
    expect(
      await ledgerCounts(imp.id).then(
        (counts) => counts.done + counts.needs_review + counts.failed
      )
    ).toBe(SHEET_ROWS.length)
    // The redelivered claim adds its own job_completed fact, but the
    // completion event itself is published exactly once (ADR-0003).
    const after = await eventTypes(imp.id)
    expect(after.filter((type) => type === "import_done")).toHaveLength(1)
  })
})
