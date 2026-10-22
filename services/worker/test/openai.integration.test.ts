/**
 * The REAL OpenAI provider driven through the DB-contract seam — the same
 * stage-handler integration scenarios the Demo stub's chaos suite covers
 * (retry, invalid JSON, rate-limit Pause, poison), but against an injected
 * fake OpenAI endpoint (createOpenAI's `fetch` seam): HTTP-500 retries with
 * backoff, an unusable-output `invalid_json`, a hanging request mapped to
 * `timeout`, a 429 engaging the per-provider Pause honoring Retry-After,
 * persistent failure quarantining the Batch rows, and — the routing
 * acceptance — model usage showing gpt-4o-mini for clean rows and gpt-4o
 * for messy rows, with real per-call micros cost.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { importStreamKey } from "@workspace/pipeline"

import {
  OPENAI_FAST_MODEL,
  OPENAI_STRONG_MODEL,
  createProviderRegistry,
  createWorker,
  defineHandlers,
  openAIProviderEntries,
  type OpenAIProviderOptions,
  type ProviderRegistry,
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
  "EAN",
  "Farbe",
]

// Same fixture as the stub enrich suite: two rows collapse into one Product
// (Gießkanne, clean), Schaufel stands alone (clean); Blumentopf has no
// description/category/brand → Messiness 55 → the strong tier.
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

// ------------------------------------------------- fake OpenAI endpoint --

type FetchFn = NonNullable<OpenAIProviderOptions["fetch"]>

interface RecordedRequest {
  body: {
    model?: string
    messages?: Array<{ role: string; content: string }>
  }
}

/** undefined = "not mine", pass to the next responder. */
type Responder = (
  request: RecordedRequest,
  init?: RequestInit
) => Response | Promise<Response> | undefined

/**
 * A scripted OpenAI endpoint: each responder consumes the calls it matches
 * (returning undefined passes to the next), the last responder is the
 * fallback. Enrich vs translate is told apart by the provider's own system
 * prompt — no response_format shape guessing.
 */
function fakeOpenAIEndpoint(...responders: Responder[]): {
  fetch: FetchFn
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetch = (async (input, init) => {
    const request: RecordedRequest = {
      body: JSON.parse(String(init?.body ?? "{}")),
    }
    requests.push(request)
    for (const respond of responders) {
      const response = respond(request, init)
      if (response !== undefined) return response
    }
    throw new Error("fake OpenAI endpoint: no responder matched")
  }) as FetchFn
  return { fetch, requests }
}

function isEnrichCall(request: RecordedRequest): boolean {
  return JSON.stringify(request.body.messages).includes("enrichment engine")
}

/** A schema-valid, gate-passing enrich output for the Product in `title`. */
function enrichOutput(title: string) {
  return {
    title,
    description: "Robuste Gießkanne aus Stahlblech.",
    category: "Garten > Bewässerung",
    tags: ["brunner", "gießkanne"],
    attributes: [{ name: "Farbe", value: "rot" }],
    confidence: {
      title: 95,
      description: 92,
      category: 90,
      tags: 85,
      attributes: 90,
    },
    status: "ready" as const,
    claims: [
      {
        text: "aus Stahlblech",
        sourceRowIndex: 1,
        sourceColumn: "Description",
      },
    ],
    reviewReasons: [],
  }
}

function completion(
  model: string | undefined,
  content: unknown,
  usage: Record<string, number>
): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: model ?? OPENAI_FAST_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage,
  })
}

/** Translated fields that differ from the source (so usage rows land). */
function translateOk(): Responder {
  return (request) => {
    if (isEnrichCall(request)) return undefined
    return completion(
      request.body.model,
      {
        title: "DE: Gießkanne 5L",
        description: "DE: Robuste Gießkanne aus Stahlblech.",
        category: "DE: Garten > Bewässerung",
      },
      { prompt_tokens: 60, completion_tokens: 40 }
    )
  }
}

/** The Product title the enrich prompt names — lets the fake vary output. */
function promptTitle(request: RecordedRequest): string {
  return (
    JSON.stringify(request.body.messages).match(/title: ([^\\"]+)/)?.[1] ??
    "Produkt"
  )
}

function enrichOk(): Responder {
  return (request) => {
    if (!isEnrichCall(request)) return undefined
    return completion(request.body.model, enrichOutput(promptTitle(request)), {
      prompt_tokens: 150,
      completion_tokens: 90,
    })
  }
}

/**
 * Fault responders pinned to the FIRST product the endpoint sees, so ONE
 * Job eats the whole failure chain (500 → invalid JSON → timeout) while
 * later Jobs sail through.
 */
function firstProductFaults(faults: Responder[]): Responder[] {
  let target: string | null = null
  return faults.map((fault) => {
    let fired = false
    return (request, init) => {
      if (fired || !isEnrichCall(request)) return undefined
      const title = promptTitle(request)
      if (target === null) target = title
      else if (title !== target) return undefined
      fired = true
      return fault(request, init)
    }
  })
}

/**
 * Hangs the FIRST enrich call until its abort signal fires — the provider's
 * per-call timeout maps the abort to the `timeout` fault (EC-082).
 */
function enrichHangOnce(): Responder {
  let fired = false
  return (request, init) => {
    if (fired || !isEnrichCall(request)) return undefined
    fired = true
    const { promise, reject } = Promise.withResolvers<Response>()
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "TimeoutError"))
    })
    return promise
  }
}

// ------------------------------------------------------------ scaffolding --

interface WorkerDeps {
  workerId: string
  endpoint: FetchFn
  timeoutMs?: number
}

function fullPipelineWorker(options: WorkerDeps) {
  const registry: ProviderRegistry = createProviderRegistry(
    openAIProviderEntries({
      apiKey: "test-key",
      fetch: options.endpoint,
      concurrency: 4,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    })
  )
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
    // Poison path identical to production wiring (main.ts).
    poisonHandlers: { enrich: failBatchRows, translate: failBatchRows },
    config: {
      workerId: options.workerId,
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      backoffBaseMs: 10,
      backoffMaxMs: 50,
    },
    planners: {
      clean: planCleanStage,
      group: planGroupStage,
      // Batch size 1: every Product gets its own enrich Batch and its own
      // Messiness tier, so the routing is visible per product.
      "match-media": (planningDb, target) =>
        planMatchMediaStage(planningDb, target, {
          batchSize: 1,
          providerForTier: (tier) => registry.providerIdForTier(tier),
        }),
      finalise: planFinaliseStage,
    },
  })
}

async function importStatus(importId: string): Promise<{
  status: string
  stage: string
  paused_until: string | null
  paused_provider_id: string | null
}> {
  const rows = (await db.db.execute(sql`
    SELECT status::text AS status, stage::text AS stage,
           paused_until::text AS paused_until,
           paused_provider_id AS paused_provider_id
    FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{
    status: string
    stage: string
    paused_until: string | null
    paused_provider_id: string | null
  }>
  return rows[0]!
}

interface UsageRow {
  operation: string
  provider_id: string
  model: string
  tokens_in: number
  tokens_out: number
  cost_micros: number
  natural_key: string | null
}

async function usageRows(importId: string): Promise<UsageRow[]> {
  return (await db.db.execute(sql`
    SELECT u.operation::text AS operation, u.provider_id, u.model,
           u.tokens_in, u.tokens_out, u.cost_micros, p.natural_key
    FROM provider_usage u
    LEFT JOIN products p ON p.id = u.product_id
    WHERE u.import_id = ${importId}
    ORDER BY u.operation, p.natural_key
  `)) as unknown as UsageRow[]
}

/** Real list prices, spelled out so the test pins the formula independently. */
const MICROS_PER_1K: Record<string, { inMicros: number; outMicros: number }> = {
  [OPENAI_FAST_MODEL]: { inMicros: 150, outMicros: 600 },
  [OPENAI_STRONG_MODEL]: { inMicros: 2_500, outMicros: 10_000 },
}

function expectedCostMicros(row: UsageRow): number {
  const price = MICROS_PER_1K[row.model]!
  return (
    Math.ceil((row.tokens_in * price.inMicros) / 1_000) +
    Math.ceil((row.tokens_out * price.outMicros) / 1_000)
  )
}

// ------------------------------------------------------------------ tests --

describe("openai provider through the pipeline", () => {
  it("routes tiers by Messiness Score, visible in model usage, priced in real micros", async () => {
    const imp = await seedUpload()
    const fake = fakeOpenAIEndpoint(enrichOk(), translateOk())
    const worker = fullPipelineWorker({
      workerId: "w-openai-routing",
      endpoint: fake.fetch,
    })
    worker.start()
    try {
      await waitFor(
        "import completed",
        async () => (await importStatus(imp.id)).status === "completed",
        20_000
      )
    } finally {
      await worker.stop()
    }

    // Plan-time stamping: the enrich Jobs carry both tiers under the one
    // provider id (`openai`) — a Pause holds the provider, not a model.
    const jobs = (await db.db.execute(sql`
      SELECT DISTINCT provider_id, routing_tier FROM jobs
      WHERE import_id = ${imp.id} AND stage = 'enrich'
    `)) as unknown as Array<{ provider_id: string; routing_tier: string }>
    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((job) => job.provider_id))).toEqual(
      new Set(["openai"])
    )
    expect(jobs.map((job) => job.routing_tier).sort()).toEqual([
      "fast",
      "strong",
    ])

    const usage = await usageRows(imp.id)
    const enrichByProduct = new Map(
      usage
        .filter((row) => row.operation === "enrich")
        .map((row) => [row.natural_key, row])
    )
    expect(enrichByProduct.size).toBe(3)

    // Clean rows → gpt-4o-mini; the messy Product (Blumentopf: no
    // description/category/brand → Messiness 55) → gpt-4o.
    expect(enrichByProduct.get("sku:bm-01")!.model).toBe(OPENAI_STRONG_MODEL)
    expect(enrichByProduct.get("sku:tp-100")!.model).toBe(OPENAI_FAST_MODEL)
    expect(enrichByProduct.get("sku:tp-101")!.model).toBe(OPENAI_FAST_MODEL)
    for (const row of enrichByProduct.values()) {
      expect(row.provider_id).toBe("openai")
    }
    // Both models really hit the endpoint.
    expect(new Set(fake.requests.map((request) => request.body.model))).toEqual(
      new Set([OPENAI_FAST_MODEL, OPENAI_STRONG_MODEL])
    )

    // Cost per call = the model's real price applied to real token counts,
    // in integer micros.
    for (const row of usage) {
      expect(row.cost_micros).toBe(expectedCostMicros(row))
      expect(Number.isInteger(row.cost_micros)).toBe(true)
    }
    // Translate ran for both locales on all three Products and was priced
    // like any other call.
    expect(usage.filter((row) => row.operation === "translate")).toHaveLength(6)
  })

  it("retries through a 500, invalid JSON and a timed-out call, then completes", async () => {
    const imp = await seedUpload()
    const fake = fakeOpenAIEndpoint(
      ...firstProductFaults([
        () =>
          new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 500,
          }),
        () =>
          completion(OPENAI_FAST_MODEL, "not json at all", {
            prompt_tokens: 10,
            completion_tokens: 5,
          }),
        enrichHangOnce(),
      ]),
      enrichOk(),
      translateOk()
    )
    const worker = fullPipelineWorker({
      workerId: "w-openai-retry",
      endpoint: fake.fetch,
      timeoutMs: 150,
    })
    worker.start()
    try {
      await waitFor(
        "import completed after provider faults",
        async () => (await importStatus(imp.id)).status === "completed",
        30_000
      )
    } finally {
      await worker.stop()
    }

    // The first enrich Job burned four real attempts (500 → invalid JSON →
    // timeout → success); the machinery's backoff ran between them.
    const attempts = (await db.db.execute(sql`
      SELECT max(attempts)::int AS max_attempts,
             count(*) FILTER (WHERE status = 'completed')::int AS completed
      FROM jobs WHERE import_id = ${imp.id} AND stage = 'enrich'
    `)) as unknown as Array<{ max_attempts: number; completed: number }>
    expect(attempts[0]!.max_attempts).toBeGreaterThanOrEqual(4)
    expect(attempts[0]!.completed).toBe(3)

    // Usage rows only for calls that SUCCEEDED — the retried Job appended
    // exactly its one real, priced call.
    const enrichUsage = (await usageRows(imp.id)).filter(
      (row) => row.operation === "enrich"
    )
    expect(enrichUsage).toHaveLength(3)
  })

  it("engages the per-provider Pause on a 429, honoring Retry-After", async () => {
    const imp = await seedUpload()
    const fake = fakeOpenAIEndpoint(
      ...firstProductFaults([
        () =>
          new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "retry-after": "1" },
          }),
      ]),
      enrichOk(),
      translateOk()
    )
    const worker = fullPipelineWorker({
      workerId: "w-openai-pause",
      endpoint: fake.fetch,
    })
    worker.start()
    try {
      // The 429 maps to rate_limited → the Pause engages for `openai` and
      // the Import surfaces it with a real countdown.
      await waitFor(
        "import paused",
        async () => (await importStatus(imp.id)).status === "paused"
      )
      const pauses = (await db.db.execute(sql`
        SELECT provider_id, reason, resume_at::text AS resume_at
        FROM provider_pauses
      `)) as unknown as Array<{
        provider_id: string
        reason: string
        resume_at: string
      }>
      expect(pauses).toHaveLength(1)
      expect(pauses[0]!.provider_id).toBe("openai")
      expect(pauses[0]!.reason).toMatch(/rate/)
      const surfaced = await importStatus(imp.id)
      expect(surfaced.paused_provider_id).toBe("openai")
      const resumeIn = new Date(surfaced.paused_until!).getTime() - Date.now()
      expect(resumeIn).toBeGreaterThan(0)
      expect(resumeIn).toBeLessThanOrEqual(1_000)

      // …and everything resumes automatically on schedule, no human action.
      await waitFor(
        "import completed after automatic resume",
        async () => (await importStatus(imp.id)).status === "completed",
        20_000
      )
      const leftover = (await db.db.execute(sql`
        SELECT count(*)::int AS count FROM provider_pauses
      `)) as unknown as Array<{ count: number }>
      expect(leftover[0]!.count).toBe(0)

      // The `paused` event named the provider on the Import's stream.
      const entries = await cache.redis.xrange(
        importStreamKey(imp.id),
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
      expect(pausedEvents.length).toBeGreaterThan(0)
      expect(pausedEvents[0]!.data.providerId).toBe("openai")
    } finally {
      await worker.stop()
    }
  })

  it("quarantines the Jobs with a reason when the provider never recovers", async () => {
    const imp = await seedUpload()
    const fake = fakeOpenAIEndpoint(
      () =>
        new Response(JSON.stringify({ error: { message: "hard down" } }), {
          status: 500,
        })
    )
    const worker = fullPipelineWorker({
      workerId: "w-openai-poison",
      endpoint: fake.fetch,
    })
    worker.start()
    try {
      await waitFor(
        "enrich jobs terminally failed",
        async () => {
          const rows = (await db.db.execute(sql`
            SELECT count(*)::int AS failed FROM jobs
            WHERE import_id = ${imp.id} AND stage = 'enrich' AND status = 'failed'
          `)) as unknown as Array<{ failed: number }>
          return rows[0]!.failed === 3
        },
        20_000
      )
    } finally {
      await worker.stop()
    }

    // Five real attempts each (the Job row's authoritative counter),
    // terminal as Failed, the last error on the Job.
    const jobs = (await db.db.execute(sql`
      SELECT status::text AS status, attempts, last_error
      FROM jobs WHERE import_id = ${imp.id} AND stage = 'enrich'
      ORDER BY batch_key
    `)) as unknown as Array<{
      status: string
      attempts: number
      last_error: string | null
    }>
    expect(jobs).toHaveLength(3)
    for (const job of jobs) {
      expect(job.status).toBe("failed")
      expect(job.attempts).toBe(5)
      expect(job.last_error).toContain("server error")
    }

    // The rows keep their terminal verdict — clean/group work that really
    // happened is never overwritten by a poisoned Job (ADR-0003); the
    // Import waits, retryable, not stranded.
    const ledger = (await db.db.execute(sql`
      SELECT state::text AS state, count(*)::int AS count,
             bool_and(failure_reason IS NULL) AS all_unreasoned
      FROM row_ledger WHERE import_id = ${imp.id}
      GROUP BY state
    `)) as unknown as Array<{
      state: string
      count: number
      all_unreasoned: boolean
    }>
    expect(ledger).toEqual([{ state: "done", count: 4, all_unreasoned: true }])
    const stalled = await importStatus(imp.id)
    expect(stalled.status).toBe("running")
    expect(stalled.stage).toBe("enrich")
    // No enrichment, no phantom usage: failed calls were never persisted.
    expect(await usageRows(imp.id)).toHaveLength(0)
  })
})
