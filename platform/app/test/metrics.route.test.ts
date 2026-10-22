/**
 * Metrics overview procedure (ticket #19) — via the typed oRPC client
 * against a real `next dev` (RPC mount at /api/rpc).
 *
 * The payload must mirror the Postgres views exactly: processing rates
 * that reconcile with the seeded Row Ledger, model usage and cost over
 * time from provider_usage, per-model speed, per-locale translation
 * coverage with the Out-of-Date count, and cheap/strong routing savings
 * priced with the same integer formula as costMicrosFor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import { createORPCClient } from "@orpc/client"
import type { ClientContract } from "@workspace/contracts"
import { RPCLink } from "@orpc/client/fetch"

import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  startTestApp,
  truncateTables,
  type TestApp,
} from "./helpers"

let app: TestApp
let db: Db
let client: ClientContract

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  app = await startTestApp()
  client = createORPCClient(new RPCLink({ url: `${app.baseUrl}/api/rpc` }))
})

beforeEach(async () => {
  await truncateTables(db)
})

afterAll(async () => {
  await app.close()
  await db.close()
  await dropTestDatabase()
})

const keyHash = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex")

async function seedImportRow(rowCount: number): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO imports (
      id, store_id, content_hash, family_key, original_filename, sheet_format,
      sheet_object_key, status, stage, row_count, sheet_header
    ) VALUES (
      ${id}, 'default', ${crypto.randomUUID().replaceAll("-", "")},
      'supplier-sheet.csv', 'supplier-sheet.csv', 'csv',
      'imports/default/x/sheet.csv', 'running', 'enrich',
      ${rowCount}, ${JSON.stringify(["SKU", "Title"])}::jsonb
    )
  `)
  return id
}

async function seedProduct(
  importId: string,
  naturalKey: string
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO products (
      id, store_id, import_id, family_key, identity_kind, natural_key,
      natural_key_hash, title, needs_review, review_reason
    ) VALUES (
      ${id}, 'default', ${importId},
      (SELECT family_key FROM imports WHERE id = ${importId}),
      'code', ${naturalKey}, ${keyHash(naturalKey)},
      ${`Product ${naturalKey}`}, false, null
    )
  `)
  return id
}

async function seedEnrichment(
  importId: string,
  productId: string,
  status: "ready" | "needs_review"
): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO product_enrichments (store_id, import_id, product_id, title, handle, confidence, status)
    VALUES (
      'default', ${importId}, ${productId}, 'Enriched',
      ${`handle-${productId.slice(0, 8)}`}, '{"title":90}'::jsonb, ${status}
    )
  `)
}

async function seedLedgerRow(
  importId: string,
  rowIndex: number,
  state: "done" | "needs_review" | "failed"
): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO row_ledger (store_id, import_id, row_index, state)
    VALUES ('default', ${importId}, ${rowIndex}, ${state})
  `)
}

interface SeedUsageOptions {
  importId: string
  productId?: string | null
  operation: "enrich" | "translate"
  providerId: string
  model: string
  tokensIn: number
  tokensOut: number
  costMicros: number
  durationMs?: number | null
  createdAt?: Date
}

async function seedUsage(options: SeedUsageOptions): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO provider_usage (
      store_id, import_id, product_id, operation, provider_id, model,
      tokens_in, tokens_out, cost_micros, duration_ms, created_at
    ) VALUES (
      'default', ${options.importId}, ${options.productId ?? null},
      ${options.operation}, ${options.providerId}, ${options.model},
      ${options.tokensIn}, ${options.tokensOut}, ${options.costMicros},
      ${options.durationMs ?? null},
      ${(options.createdAt ?? new Date()).toISOString()}
    )
  `)
}

async function seedTranslation(
  importId: string,
  productId: string,
  locale: string,
  field: string,
  outOfDate = false
): Promise<void> {
  const source = `${field} source of ${productId}`
  await db.db.execute(sql`
    INSERT INTO product_translations (
      store_id, import_id, product_id, locale, field, text,
      source_text_hash, origin, out_of_date
    ) VALUES (
      'default', ${importId}, ${productId}, ${locale}, ${field},
      ${`${field} übersetzt`}, ${keyHash(source)}, 'ai', ${outOfDate}
    ) ON CONFLICT (product_id, locale, field) DO NOTHING
  `)
}

/**
 * One import, a 10-row sheet with 6 done + 2 needs-review + 2 failed
 * ledger rows, one enriched product, and four provider_usage rows: two
 * cheap-model enrich calls (durations 1200/400 ms) on separate days plus
 * one strong-model call that must not enter the savings view.
 */
async function seedMetricsScenario(): Promise<{ importId: string }> {
  const importId = await seedImportRow(10)
  const productId = await seedProduct(importId, "sku:t-1")
  await seedEnrichment(importId, productId, "ready")

  for (let index = 1; index <= 6; index++) {
    await seedLedgerRow(importId, index, "done")
  }
  await seedLedgerRow(importId, 7, "needs_review")
  await seedLedgerRow(importId, 8, "needs_review")
  await seedLedgerRow(importId, 9, "failed")
  await seedLedgerRow(importId, 10, "failed")

  // Cheap-model calls. costMicrosFor("stub-demo-v1"): in 50/1k, out 200/1k.
  // call 1: ceil(1000·50/1000) + ceil(1000·200/1000) = 50 + 200 = 250
  const day = new Date("2026-03-10T12:00:00Z")
  await seedUsage({
    importId,
    productId,
    operation: "enrich",
    providerId: "stub",
    model: "stub-demo-v1",
    tokensIn: 1000,
    tokensOut: 1000,
    costMicros: 250,
    durationMs: 1200,
    createdAt: day,
  })
  // call 2: ceil(2000·50/1000) + ceil(500·200/1000) = 100 + 100 = 200
  await seedUsage({
    importId,
    productId,
    operation: "enrich",
    providerId: "stub",
    model: "stub-demo-v1",
    tokensIn: 2000,
    tokensOut: 500,
    costMicros: 200,
    durationMs: 400,
    createdAt: new Date("2026-03-11T12:00:00Z"),
  })
  // Strong-model call — priced, used, but excluded from routing savings.
  // costMicrosFor("gpt-4o"): ceil(1000·2500/1000) + ceil(1000·10000/1000).
  await seedUsage({
    importId,
    productId,
    operation: "enrich",
    providerId: "openai",
    model: "gpt-4o",
    tokensIn: 1000,
    tokensOut: 1000,
    costMicros: 12_500,
    durationMs: 3_000,
    createdAt: day,
  })

  // Coverage: de has title + description, fr has title only, one de field
  // is Out-of-Date. Denominator: 1 enriched product × 3 fields per locale.
  await seedTranslation(importId, productId, "de", "title", true)
  await seedTranslation(importId, productId, "de", "description")
  await seedTranslation(importId, productId, "fr", "title")

  return { importId }
}

describe("metrics.overview", () => {
  it("reconciles processing rates with the Row Ledger", async () => {
    await seedMetricsScenario()

    const overview = await client.metrics.overview()

    expect(overview.rates).toEqual({
      totalRows: 10,
      doneRows: 6,
      needsReviewRows: 2,
      failedRows: 2,
      donePct: 60,
      needsReviewPct: 20,
      failedPct: 20,
    })
    // The rates ARE the ledger: done + needsReview + failed = totalRows.
    expect(
      overview.rates.doneRows +
        overview.rates.needsReviewRows +
        overview.rates.failedRows
    ).toBe(overview.rates.totalRows)
  })

  it("aggregates model usage, cost over time and speed from provider_usage", async () => {
    await seedMetricsScenario()

    const overview = await client.metrics.overview()

    // Model usage: cheap stub rows (2 calls) and the gpt-4o row separate.
    const stub = overview.modelUsage.find(
      (row: { model: string }) => row.model === "stub-demo-v1"
    )
    expect(stub).toMatchObject({
      providerId: "stub",
      operation: "enrich",
      calls: 2,
      tokensIn: 3000,
      tokensOut: 1500,
      costMicros: 450,
    })
    const strong = overview.modelUsage.find(
      (row: { model: string }) => row.model === "gpt-4o"
    )
    expect(strong).toMatchObject({ calls: 1, costMicros: 12_500 })

    // Cost over time: day 1 carries both the stub call and gpt-4o.
    expect(overview.costOverTime).toEqual([
      { day: "2026-03-10", calls: 2, costMicros: 12_750 },
      { day: "2026-03-11", calls: 1, costMicros: 200 },
    ])

    // Speed per model: avg(1200, 400) = 800, slowest 1200; gpt-4o 3000.
    const stubSpeed = overview.speed.find(
      (row: { model: string }) => row.model === "stub-demo-v1"
    )
    expect(stubSpeed).toMatchObject({
      providerId: "stub",
      operation: "enrich",
      calls: 2,
      avgDurationMs: 800,
      slowestDurationMs: 1200,
    })
    expect(
      overview.speed.find((row: { model: string }) => row.model === "gpt-4o")
    ).toMatchObject({
      avgDurationMs: 3000,
      slowestDurationMs: 3000,
    })
  })

  it("reports translation coverage per locale with the Out-of-Date count", async () => {
    await seedMetricsScenario()

    const overview = await client.metrics.overview()

    expect(overview.translationCoverage).toEqual([
      {
        locale: "de",
        productsEnriched: 1,
        productsTranslated: 1,
        fieldsTranslated: 2,
        coveragePct: 66.67,
        outOfDate: 1,
      },
      {
        locale: "fr",
        productsEnriched: 1,
        productsTranslated: 1,
        fieldsTranslated: 1,
        coveragePct: 33.33,
        outOfDate: 0,
      },
    ])
  })

  it("prices cheap/strong routing savings off the strong model", async () => {
    await seedMetricsScenario()

    const overview = await client.metrics.overview()

    // Only the cheap model appears; gpt-4o calls are never "savings".
    expect(overview.routingSavings).toHaveLength(1)
    const savings = overview.routingSavings[0]!
    expect(savings).toMatchObject({
      providerId: "stub",
      model: "stub-demo-v1",
      operation: "enrich",
      calls: 2,
      actualCostMicros: 450,
      // Strong-model hypothetical at gpt-4o list prices:
      // call 1: ceil(1000·2.5) + ceil(1000·10) = 12_500
      // call 2: ceil(2000·2.5) + ceil(500·10)  = 10_000
      strongCostMicros: 22_500,
      savedMicros: 22_050,
    })
  })

  it("returns zeroed, well-formed blocks on an empty store", async () => {
    const overview = await client.metrics.overview()

    expect(overview.rates).toEqual({
      totalRows: 0,
      doneRows: 0,
      needsReviewRows: 0,
      failedRows: 0,
      donePct: 0,
      needsReviewPct: 0,
      failedPct: 0,
    })
    expect(overview.modelUsage).toEqual([])
    expect(overview.costOverTime).toEqual([])
    expect(overview.speed).toEqual([])
    expect(overview.translationCoverage).toEqual([])
    expect(overview.routingSavings).toEqual([])
  })
})
