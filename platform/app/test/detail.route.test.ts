/**
 * Import detail + re-run procedures — via the typed oRPC client against a
 * real `next dev` (RPC mount at /api/rpc).
 *
 * The detail snapshot must carry per-stage Job counts, a Row Ledger
 * reconciliation that adds up to the sheet total, per-row errors with the
 * Jobs that can retry them, Parked Photos with reasons, and the Products.
 * The rerun procedure must record the Re-run FACT exactly as the Worker's
 * sweeper expects it (ADR-0004) and reject malformed or cross-Import
 * selections.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import { createORPCClient, isDefinedError, ORPCError, safe } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import type { ClientContract } from "@workspace/contracts"

import type { StageJobCounts } from "@/lib/imports"

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

interface SeedImportOptions {
  rowCount?: number | null
  status?: string
  stage?: string
  pausedUntil?: Date | null
  pausedProviderId?: string | null
}

async function seedImportRow(options: SeedImportOptions = {}): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO imports (
      id, store_id, content_hash, family_key, original_filename, sheet_format,
      sheet_object_key, status, stage, row_count, sheet_header,
      paused_until, paused_provider_id
    ) VALUES (
      ${id}, 'default', ${crypto.randomUUID().replaceAll("-", "")},
      'supplier-sheet.csv', 'supplier-sheet.csv', 'csv',
      'imports/default/x/sheet.csv',
      ${options.status ?? "running"}, ${options.stage ?? "enrich"},
      ${options.rowCount ?? null},
      ${JSON.stringify(["SKU", "Title"])}::jsonb,
      ${options.pausedUntil ? options.pausedUntil.toISOString() : null},
      ${options.pausedProviderId ?? null}
    )
  `)
  return id
}

interface SeedJobOptions {
  importId: string
  stage: string
  batchKey: string
  status: "pending" | "running" | "completed" | "failed"
}

async function seedJob(options: SeedJobOptions): Promise<string> {
  const rows = (await db.db.execute(sql`
    INSERT INTO jobs (store_id, import_id, stage, batch_key, status)
    VALUES ('default', ${options.importId}, ${options.stage}, ${options.batchKey}, ${options.status})
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return rows[0]!.id
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
      'code', ${naturalKey},
      ${keyHash(naturalKey)}, ${`Product ${naturalKey}`}, false, null
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
      'default', ${importId}, ${productId}, ${`Enriched ${productId.slice(0, 4)}`},
      ${`handle-${productId.slice(0, 8)}`}, '{"title":90}'::jsonb, ${status}
    )
  `)
}

interface SeedLedgerOptions {
  importId: string
  rowIndex: number
  state: "done" | "needs_review" | "failed"
  productId?: string | null
  failureReason?: string | null
  failureEc?: string | null
}

async function seedLedgerRow(options: SeedLedgerOptions): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO row_ledger (store_id, import_id, row_index, state, product_id, failure_reason, failure_ec)
    VALUES (
      'default', ${options.importId}, ${options.rowIndex}, ${options.state},
      ${options.productId ?? null}, ${options.failureReason ?? null},
      ${options.failureEc ?? null}
    )
  `)
}

async function seedParkedPhoto(
  importId: string,
  filename: string
): Promise<void> {
  const fileId = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO import_files (id, store_id, import_id, kind, object_key, filename)
    VALUES (${fileId}, 'default', ${importId}, 'photo', 'imports/default/x/photo.jpg', ${filename})
  `)
  await db.db.execute(sql`
    INSERT INTO parked_photos (store_id, import_id, import_file_id, reason, ec)
    VALUES (
      'default', ${importId}, ${fileId},
      'No SKU, GTIN or title token matched a product in this import.', 'EC-072'
    )
  `)
}

/** Products of the import in deterministic batch order. */
async function productsInBatchOrder(importId: string): Promise<string[]> {
  return (
    (await db.db.execute(sql`
      SELECT id FROM products WHERE import_id = ${importId}
      ORDER BY natural_key_hash
    `)) as unknown as Array<{ id: string }>
  ).map((row) => row.id)
}

/**
 * A mid-flight import: 9 jobs across five stages, a 10-row sheet with 6
 * done + 2 needs-review + 2 failed ledger rows, 4 products (2 enriched),
 * one parked photo.
 */
async function seedDetailScenario(): Promise<{
  importId: string
  failedEnrichJobId: string
}> {
  const importId = await seedImportRow({ rowCount: 10 })

  await seedJob({
    importId,
    stage: "intake",
    batchKey: "intake",
    status: "completed",
  })
  await seedJob({
    importId,
    stage: "clean",
    batchKey: "clean-000001-000500",
    status: "completed",
  })
  await seedJob({
    importId,
    stage: "clean",
    batchKey: "clean-000501-001000",
    status: "completed",
  })
  await seedJob({
    importId,
    stage: "group",
    batchKey: "group",
    status: "completed",
  })
  await seedJob({
    importId,
    stage: "match-media",
    batchKey: "media",
    status: "completed",
  })
  await seedJob({
    importId,
    stage: "enrich",
    batchKey: "products-000001-000002",
    status: "completed",
  })
  await seedJob({
    importId,
    stage: "enrich",
    batchKey: "products-000003-000003",
    status: "running",
  })
  const failedEnrichJobId = await seedJob({
    importId,
    stage: "enrich",
    batchKey: "products-000004-000004",
    status: "failed",
  })
  await seedJob({
    importId,
    stage: "translate",
    batchKey: "products-000001-000002:de",
    status: "pending",
  })
  await seedJob({
    importId,
    stage: "translate",
    batchKey: "products-000001-000002:fr",
    status: "pending",
  })

  for (const key of ["sku:t-1", "sku:t-2", "sku:t-3", "sku:t-4"]) {
    await seedProduct(importId, key)
  }
  const ordered = await productsInBatchOrder(importId)
  expect(ordered).toHaveLength(4)
  await seedEnrichment(importId, ordered[0]!, "ready")
  await seedEnrichment(importId, ordered[1]!, "needs_review")

  for (let index = 1; index <= 6; index++) {
    await seedLedgerRow({ importId, rowIndex: index, state: "done" })
  }
  await seedLedgerRow({
    importId,
    rowIndex: 7,
    state: "needs_review",
    productId: ordered[1]!,
  })
  await seedLedgerRow({
    importId,
    rowIndex: 8,
    state: "needs_review",
    productId: ordered[1]!,
  })
  // Row 9 failed with its product inside the failed enrich Job's Batch…
  await seedLedgerRow({
    importId,
    rowIndex: 9,
    state: "failed",
    productId: ordered[3]!, // ordinal 4 → inside products-000004-000004
    failureReason:
      "The enrich stage failed 5× for this row's product batch and gave up (poison).",
    failureEc: "EC-122",
  })
  // …row 10 failed before grouping (no Product, nothing to retry).
  await seedLedgerRow({
    importId,
    rowIndex: 10,
    state: "failed",
    failureReason: "No supplier code and no title — nothing to group by.",
    failureEc: "EC-031",
  })

  await seedParkedPhoto(importId, "IMG_4472.JPG")
  return { importId, failedEnrichJobId }
}

describe("import.detail (detail snapshot)", () => {
  it("returns per-stage job counts, reconciliation, errors, parked photos and products", async () => {
    const { importId, failedEnrichJobId } = await seedDetailScenario()

    const { import: detail } = await client.import.detail({ id: importId })

    expect(detail.id).toBe(importId)
    expect(detail.rowCount).toBe(10)
    expect(detail.pausedUntil).toBeNull()

    // Per-stage counts, all seven stages present.
    expect(Object.keys(detail.stages).sort()).toEqual(
      [
        "clean",
        "enrich",
        "finalise",
        "group",
        "intake",
        "match-media",
        "translate",
      ].sort()
    )
    expect(detail.stages.intake).toEqual<StageJobCounts>({
      pending: 0,
      running: 0,
      completed: 1,
      failed: 0,
    })
    expect(detail.stages.clean).toEqual<StageJobCounts>({
      pending: 0,
      running: 0,
      completed: 2,
      failed: 0,
    })
    expect(detail.stages.enrich).toEqual<StageJobCounts>({
      pending: 0,
      running: 1,
      completed: 1,
      failed: 1,
    })
    expect(detail.stages.translate).toEqual<StageJobCounts>({
      pending: 2,
      running: 0,
      completed: 0,
      failed: 0,
    })
    expect(detail.stages.finalise).toEqual<StageJobCounts>({
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    })

    // Reconciliation adds up beside the sheet total.
    expect(detail.reconciliation).toEqual({
      sheetRows: 10,
      done: 6,
      needsReview: 2,
      failed: 2,
      inProgress: 0,
    })
    const ledger = detail.reconciliation
    expect(
      ledger.done +
        ledger.needsReview +
        ledger.failed +
        (ledger.inProgress ?? 0)
    ).toBe(ledger.sheetRows)

    // Errors: reasons, EC ids, and the retryable Jobs of the poisoned row.
    expect(detail.errors.total).toBe(2)
    expect(detail.errors.rows).toHaveLength(2)
    const [row9, row10] = detail.errors.rows
    expect(row9).toMatchObject({
      rowIndex: 9,
      ec: "EC-122",
    })
    expect(row9!.reason).toContain("poison")
    expect(row9!.jobIds).toEqual([failedEnrichJobId])
    expect(row10).toMatchObject({
      rowIndex: 10,
      ec: "EC-031",
      jobIds: [],
    })

    // Parked photos carry filename + reason.
    expect(detail.parkedPhotos.total).toBe(1)
    expect(detail.parkedPhotos.rows[0]).toMatchObject({
      filename: "IMG_4472.JPG",
      ec: "EC-072",
    })
    expect(detail.parkedPhotos.rows[0]!.reason).toContain("No SKU")

    // Products in batch order with enrichment status.
    const ordered = await productsInBatchOrder(importId)
    expect(detail.products.total).toBe(4)
    expect(detail.products.rows.map((p) => p.id)).toEqual(ordered)
    expect(detail.products.rows[0]).toMatchObject({
      enrichmentStatus: "ready",
      needsReview: false,
    })
    expect(detail.products.rows[1]).toMatchObject({
      enrichmentStatus: "needs_review",
    })
    expect(detail.products.rows[2]).toMatchObject({
      enrichmentStatus: null,
      enrichedAt: null,
    })
    expect(detail.products.rows[0]!.enrichedAt).not.toBeNull()
  })

  it("exposes the pause surface (paused_until) for the countdown", async () => {
    const until = new Date(Date.now() + 5 * 60_000)
    const importId = await seedImportRow({
      status: "paused",
      stage: "enrich",
      rowCount: 4,
      pausedUntil: until,
      pausedProviderId: "stub",
    })

    const { import: detail } = await client.import.detail({ id: importId })
    expect(detail.status).toBe("paused")
    expect(detail.pausedProviderId).toBe("stub")
    expect(detail.pausedUntil).toBe(until.toISOString())
  })

  it("throws IMPORT_NOT_FOUND for unknown and malformed ids", async () => {
    const [missingError] = await safe(
      client.import.detail({ id: crypto.randomUUID() })
    )
    expect(isDefinedError(missingError)).toBe(true)
    if (isDefinedError(missingError)) {
      expect(missingError.code).toBe("IMPORT_NOT_FOUND")
      expect(missingError.message).toBe("Import not found.")
    }

    // A non-UUID id is rejected by the contract's input validation.
    const [malformedError] = await safe(
      client.import.detail({ id: "not-a-uuid" })
    )
    expect(isDefinedError(malformedError)).toBe(false)
    expect(malformedError).toBeInstanceOf(ORPCError)
    if (malformedError instanceof ORPCError) {
      expect(malformedError.code).toBe("BAD_REQUEST")
    }
  })
})

describe("import.rerun (Re-run fact)", () => {
  it("records the fact with the chosen products", async () => {
    const importId = await seedImportRow({ rowCount: 4 })
    const ordered: string[] = []
    for (const key of ["sku:r-1", "sku:r-2", "sku:r-3"]) {
      ordered.push(await seedProduct(importId, key))
    }

    const payload = await client.import.rerun({
      id: importId,
      productIds: [ordered[0]!, ordered[2]!],
    })
    expect(payload.requested).toBe(2)
    expect(payload.stage).toBe("enrich")
    expect(payload.productIds).toEqual([ordered[0], ordered[2]])

    const facts = (await db.db.execute(sql`
      SELECT store_id, import_id, stage, product_ids FROM reruns
      WHERE import_id = ${importId}
    `)) as unknown as Array<{
      store_id: string
      import_id: string
      stage: string
      product_ids: string[]
    }>
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      store_id: "default",
      import_id: importId,
      stage: "enrich",
    })
    expect([...facts[0]!.product_ids].sort()).toEqual(
      [ordered[0], ordered[2]].sort()
    )
  })

  it("is harmless on repeat clicks (a second fact adopts as a no-op)", async () => {
    const importId = await seedImportRow({ rowCount: 2 })
    const product = await seedProduct(importId, "sku:d-1")

    for (let i = 0; i < 2; i++) {
      await client.import.rerun({
        id: importId,
        productIds: [product],
      })
    }
    const facts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM reruns WHERE import_id = ${importId}
    `)) as unknown as Array<{ count: number }>
    expect(facts[0]!.count).toBe(2)
  })

  it("rejects missing, empty and non-uuid selections as input validation errors", async () => {
    const importId = await seedImportRow({ rowCount: 1 })

    // A malformed body is impossible over the typed client, but an invalid
    // payload (empty or non-uuid selection) still surfaces as an oRPC
    // validation error, not a record.
    const [emptyError] = await safe(
      client.import.rerun({ id: importId, productIds: [] })
    )
    expect(isDefinedError(emptyError)).toBe(false)
    expect(emptyError).toBeInstanceOf(ORPCError)
    expect((emptyError as ORPCError<string, unknown>).code).toBe("BAD_REQUEST")

    const [badUuidError] = await safe(
      client.import.rerun({ id: importId, productIds: ["nope"] })
    )
    expect(isDefinedError(badUuidError)).toBe(false)
    expect(badUuidError).toBeInstanceOf(ORPCError)

    const facts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM reruns WHERE import_id = ${importId}
    `)) as unknown as Array<{ count: number }>
    expect(facts[0]!.count).toBe(0)
  })

  it("rejects products from another import with UNKNOWN_PRODUCTS", async () => {
    const importId = await seedImportRow({ rowCount: 1 })
    const otherImport = await seedImportRow({ rowCount: 1 })
    const foreignProduct = await seedProduct(otherImport, "sku:f-1")

    const [error] = await safe(
      client.import.rerun({ id: importId, productIds: [foreignProduct] })
    )
    expect(error).toBeInstanceOf(ORPCError)
    expect((error as ORPCError<string, unknown>).code).toBe("UNKNOWN_PRODUCTS")
    expect((error as ORPCError<string, unknown>).status).toBe(422)
  })

  it("throws IMPORT_NOT_FOUND for an unknown import", async () => {
    const [error] = await safe(
      client.import.rerun({
        id: crypto.randomUUID(),
        productIds: [crypto.randomUUID()],
      })
    )
    expect(isDefinedError(error)).toBe(true)
    if (isDefinedError(error)) {
      expect(error.code).toBe("IMPORT_NOT_FOUND")
    }
  })
})
