/**
 * The `enrich` Stage handler: one Job enriches one deterministic product
 * Batch (GLOSSARY: Batch) through the provider registry (the only AI
 * injection point). Writes the brief's JSON shape per Product, gates
 * low-confidence output into Needs Review with reasons (EC-099 — the
 * machinery is real in Demo Mode), and records one synthetic usage row per
 * provider call so cost aggregates by Import and Product.
 *
 * Idempotent (ADR-0003): enrichment upserts on the Product and gating only
 * ever sets (never clears) Needs Review — a redelivered Job converges.
 * Usage rows are the documented exception: a retry really paid for another
 * call, so it appends another row. Stage advancement does not happen here:
 * the Job machinery advances the Import when the last Batch completes.
 */
import { eq, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import {
  productEnrichments,
  imports,
  products,
  providerUsage,
  rowLedger,
} from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import type { JobContext, JobHandler } from "../handlers"
import { parseProductBatchKey } from "../media/plan"
import {
  routingTierFor,
  syntheticCostMicros,
  type EnrichInput,
  type EnrichmentResult,
  type ProviderRegistry,
} from "../provider"

const log = createLogger({ service: "worker:enrich" })

export interface EnrichDeps {
  registry: ProviderRegistry
}

export function createEnrichHandler(deps: EnrichDeps): JobHandler {
  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx
    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `enrich: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op

    // An enrich Batch key never carries a locale — that is translate's.
    const range = parseProductBatchKey(job.batchKey)
    if (!range || range.locale !== null) {
      throw new Error(`enrich: unparseable product-batch key "${job.batchKey}"`)
    }

    const batch = await loadBatchProducts(
      db,
      job.importId,
      range.start,
      range.end
    )
    for (const product of batch) {
      await enrichProduct(db, deps.registry, job.storeId, job.importId, product)
    }

    log.info(`enrich batch completed`, {
      importId: job.importId,
      jobId: job.id,
      batchKey: job.batchKey,
      products: batch.length,
    })
  }
}

interface ImportRecord {
  id: string
  status: string
}

async function loadImport(
  db: Database,
  importId: string
): Promise<ImportRecord | null> {
  const rows = await db
    .select({ id: imports.id, status: imports.status })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)
  return rows[0] ?? null
}

interface BatchProduct {
  id: string
  title: string
  brand: string | null
  category: string | null
  description: string | null
  gtin: string | null
  identityKind: "code" | "title"
  naturalKey: string
  naturalKeyHash: string
  needsReview: boolean
  reviewReason: string | null
}

/**
 * The Batch's Products, in the planner's deterministic order (ordinal in
 * `natural_key_hash` order — ADR-0002), so `OFFSET/LIMIT` re-derives
 * identical membership on re-runs and re-plans.
 */
async function loadBatchProducts(
  db: Database,
  importId: string,
  start: number,
  end: number
): Promise<BatchProduct[]> {
  const rows = (await db.execute(sql`
    SELECT id, title, brand, category, description, gtin,
           identity_kind, natural_key, natural_key_hash,
           needs_review, review_reason
    FROM products
    WHERE import_id = ${importId}
    ORDER BY natural_key_hash
    OFFSET ${start - 1} LIMIT ${end - start + 1}
  `)) as unknown as Array<{
    id: string
    title: string
    brand: string | null
    category: string | null
    description: string | null
    gtin: string | null
    identity_kind: "code" | "title"
    natural_key: string
    natural_key_hash: string
    needs_review: boolean
    review_reason: string | null
  }>
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    brand: row.brand,
    category: row.category,
    description: row.description,
    gtin: row.gtin,
    identityKind: row.identity_kind,
    naturalKey: row.natural_key,
    naturalKeyHash: row.natural_key_hash,
    needsReview: row.needs_review,
    reviewReason: row.review_reason,
  }))
}

/**
 * The Messiness Score signal (GLOSSARY): missing fields, review state,
 * variant/photo spread. Decides the routing tier — nothing else in Demo Mode.
 */
export function messinessScore(
  product: BatchProduct,
  variantCount: number,
  photoCount: number
): number {
  let score = 0
  if (product.identityKind === "title") score += 30
  if (!product.description) score += 20
  if (!product.category) score += 15
  if (!product.brand) score += 10
  if (!product.gtin) score += 10
  if (product.needsReview) score += 15
  score += Math.min(variantCount, 4) * 2
  score += Math.min(photoCount, 3) * 2
  return Math.min(100, score)
}

async function enrichProduct(
  db: Database,
  registry: ProviderRegistry,
  storeId: string,
  importId: string,
  product: BatchProduct
): Promise<void> {
  const memberRows = (await db.execute(sql`
    SELECT row_index FROM row_ledger
    WHERE import_id = ${importId}
      AND product_id = ${product.id} AND state <> 'failed'
    ORDER BY row_index
  `)) as unknown as Array<{ row_index: number }>

  const variants = (await db.execute(sql`
    SELECT attributes FROM variants
    WHERE product_id = ${product.id}
    ORDER BY variant_key
  `)) as unknown as Array<{ attributes: Record<string, string> | null }>
  // First value wins in variant_key order — deterministic merge.
  const attributes: Record<string, string> = {}
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.attributes ?? {})) {
      if (!(name in attributes)) attributes[name] = value
    }
  }

  const photoRows = (await db.execute(sql`
    SELECT count(*)::int AS count FROM product_photos WHERE product_id = ${product.id}
  `)) as unknown as Array<{ count: number }>
  const photoCount = photoRows[0]?.count ?? 0

  const input: EnrichInput = {
    product: {
      naturalKey: product.naturalKey,
      naturalKeyHash: product.naturalKeyHash,
      identityKind: product.identityKind,
      title: product.title,
      brand: product.brand,
      category: product.category,
      description: product.description,
      gtin: product.gtin,
    },
    attributes,
    photoCount,
    messiness: messinessScore(product, variants.length, photoCount),
    sourceRows: memberRows.map((row) => row.row_index),
  }

  const call = await registry.run(routingTierFor(input.messiness), (provider) =>
    provider.enrich(input)
  )

  await upsertEnrichment(db, storeId, importId, product.id, call.value)
  if (call.value.status === "needs_review") {
    await gateNeedsReview(db, product, call.value.reviewReasons)
  }
  await db.insert(providerUsage).values({
    storeId,
    importId,
    productId: product.id,
    operation: "enrich",
    providerId: call.usage.providerId,
    model: call.usage.model,
    tokensIn: call.usage.tokensIn,
    tokensOut: call.usage.tokensOut,
    costMicros: syntheticCostMicros(call.usage),
  })
}

async function upsertEnrichment(
  db: Database,
  storeId: string,
  importId: string,
  productId: string,
  value: EnrichmentResult
): Promise<void> {
  await db
    .insert(productEnrichments)
    .values({
      storeId,
      importId,
      productId,
      title: value.title,
      handle: value.handle,
      description: value.description,
      category: value.category,
      tags: value.tags,
      attributes: value.attributes,
      confidence: value.confidence,
      status: value.status,
      claims: value.claims,
      reviewReasons: value.reviewReasons,
      sourceRowIndexes: value.sourceRows,
    })
    .onConflictDoUpdate({
      target: productEnrichments.productId,
      set: {
        title: sql`EXCLUDED.title`,
        handle: sql`EXCLUDED.handle`,
        description: sql`EXCLUDED.description`,
        category: sql`EXCLUDED.category`,
        tags: sql`EXCLUDED.tags`,
        attributes: sql`EXCLUDED.attributes`,
        confidence: sql`EXCLUDED.confidence`,
        status: sql`EXCLUDED.status`,
        claims: sql`EXCLUDED.claims`,
        reviewReasons: sql`EXCLUDED.review_reasons`,
        sourceRowIndexes: sql`EXCLUDED.source_row_indexes`,
        updatedAt: new Date(),
      },
    })
}

/**
 * Low-confidence gating (EC-099): flag the Product Needs Review — keeping
 * the group Stage's reason when it already flagged — and mirror the state
 * onto the Product's `done` ledger rows. Failed rows stay Failed; gating
 * never clears, so a redelivered Job converges (ADR-0003).
 */
async function gateNeedsReview(
  db: Database,
  product: BatchProduct,
  reasons: string[]
): Promise<void> {
  const reason =
    product.reviewReason ?? `Low-confidence enrichment: ${reasons.join(" ")}`
  await db.execute(sql`
    UPDATE products SET
      needs_review = true,
      review_reason = ${reason},
      updated_at = now()
    WHERE id = ${product.id} AND needs_review = false
  `)
  await db
    .update(rowLedger)
    .set({ state: "needs_review", updatedAt: new Date() })
    .where(
      sql`row_ledger.product_id = ${product.id} AND row_ledger.state = 'done'`
    )
}
