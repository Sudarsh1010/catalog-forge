/**
 * The `enrich` Stage handler: one Job enriches one deterministic product
 * Batch (GLOSSARY: Batch) through the provider registry (the only AI
 * injection point). Writes the brief's JSON shape per Product, gates
 * low-confidence output into Needs Review with reasons (EC-099 — the
 * machinery is real in Demo Mode), and records one synthetic usage row per
 * provider call so cost aggregates by Import and Product.
 *
 * Routing is per row (spec #12): the model tier for EACH enrich call comes
 * from that Product's enrich-time photo-aware Messiness Score, so clean
 * rows in a mixed Batch stay on the fast tier. The Job's plan-time
 * routing_tier/provider_id stamp is claim-gate and Pause metadata only (a
 * Pause holds the whole Batch under its neediest tier's provider). Matched
 * photos (EC-072) are downloaded from object storage and passed through so
 * the strong tier performs real vision.
 *
 * Idempotent (ADR-0003): enrichment upserts on the Product and gating only
 * ever sets (never clears) Needs Review — a redelivered Job converges.
 * Usage rows are the documented exception: a retry really paid for another
 * call, so it appends another row. Stage advancement does not happen here:
 * the Job machinery advances the Import when the last Batch completes.
 */
import { eq, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { Storage } from "@workspace/storage"
import {
  productEnrichments,
  imports,
  providerUsage,
  rowLedger,
} from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import type { JobContext, JobHandler } from "../handlers"
import { parseProductBatchKey } from "@workspace/pipeline"
import { messinessScore } from "../messiness"
import { healBatchRows } from "../poison"
import { downloadObject } from "../storage"
import {
  routingTierFor,
  costMicrosFor,
  type EnrichInput,
  type EnrichPhoto,
  type EnrichmentResult,
  type ProviderRegistry,
} from "../provider"

const log = createLogger({ service: "worker:enrich" })

export interface EnrichDeps {
  registry: ProviderRegistry
  /**
   * Object storage for the matched photos' bytes — loaded at enrich time so
   * the strong-tier provider can send real image content parts (vision).
   * Optional: when absent (Demo Mode tests), photos are counted but their
   * bytes are never loaded and inputs carry no `photos`.
   */
  storage?: Storage
}

/** The post-merge enrichment state the gating decision reads. */
interface EnrichmentUpsert {
  status: "ready" | "needs_review"
  reviewReasons: string[]
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
    // Raw Sheet Row cells per Product — the evidence Claims cite. One join
    // for the whole Batch; the prompt renders them row by row.
    const sourceRowsByProduct = await loadSourceRows(
      db,
      job.importId,
      imp.sheetHeader,
      batch.map((product) => product.id)
    )
    // The Job's routing_tier/provider_id stamp (plan time) is claim-gate and
    // Pause metadata only — the Pause claim gate holds the whole Batch under
    // its neediest tier's provider. The model tier for EACH enrich call is
    // chosen per product inside enrichProduct, from the enrich-time
    // photo-aware Messiness Score — clean rows in a mixed Batch route fast.
    for (const product of batch) {
      await enrichProduct(
        db,
        deps.registry,
        deps.storage,
        job.storeId,
        job.importId,
        product,
        sourceRowsByProduct.get(product.id)
      )
    }
    // A retry that succeeded heals the poison quarantine (EC-122): rows
    // this Batch had driven Failed return to their durable terminal state.
    await healBatchRows(db, job.importId, job.batchKey)

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
  /** The sheet's column headers — names the provider's Claims can cite. */
  sheetHeader: string[] | null
}

async function loadImport(
  db: Database,
  importId: string
): Promise<ImportRecord | null> {
  const rows = (await db
    .select({
      id: imports.id,
      status: imports.status,
      sheetHeader: imports.sheetHeader,
    })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)) as ImportRecord[]
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
 * The raw Sheet Row cells behind each Product's `row_ledger` membership —
 * header-named (imports.sheet_header order; unnamed overflow columns fall
 * back to `column N`), exactly as the supplier sent them (GLOSSARY: Sheet
 * Row). One join for the whole Batch, keyed by Product.
 */
async function loadSourceRows(
  db: Database,
  importId: string,
  sheetHeader: string[] | null,
  productIds: string[]
): Promise<
  Map<string, Array<{ rowIndex: number; values: Record<string, string> }>>
> {
  const byProduct = new Map<
    string,
    Array<{ rowIndex: number; values: Record<string, string> }>
  >()
  if (productIds.length === 0) return byProduct
  const rows = (await db.execute(sql`
    SELECT rl.product_id, sr.row_index, sr.raw
    FROM row_ledger rl
    JOIN sheet_rows sr
      ON sr.import_id = rl.import_id AND sr.row_index = rl.row_index
    WHERE rl.import_id = ${importId}
      AND rl.state <> 'failed'
      AND rl.product_id IN (${sql.join(
        productIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
    ORDER BY rl.product_id, sr.row_index
  `)) as unknown as Array<{
    product_id: string
    row_index: number
    raw: unknown[] | null
  }>
  const header = sheetHeader ?? []
  for (const row of rows) {
    const values: Record<string, string> = {}
    ;(row.raw ?? []).forEach((cell, index) => {
      if (cell === null || cell === undefined) return
      values[header[index] ?? `column ${index + 1}`] = String(cell)
    })
    const list = byProduct.get(row.product_id) ?? []
    list.push({ rowIndex: row.row_index, values })
    byProduct.set(row.product_id, list)
  }
  return byProduct
}

/**
 * Download one photo's bytes for the provider call. Photos are small images
 * (the intake's own extraction path treats them the same way); the SDK
 * needs the whole content in memory anyway.
 */
async function photoBytes(storage: Storage, key: string): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of await downloadObject(storage, key)) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function enrichProduct(
  db: Database,
  registry: ProviderRegistry,
  storage: Storage | undefined,
  storeId: string,
  importId: string,
  product: BatchProduct,
  sourceRowValues?: Array<{ rowIndex: number; values: Record<string, string> }>
): Promise<void> {
  const memberRows = (await db.execute(sql`
    SELECT row_index FROM row_ledger
    WHERE import_id = ${importId}
      AND product_id = ${product.id} AND state <> 'failed'
    ORDER BY row_index
  `)) as unknown as Array<{ row_index: number }>

  const variants = (await db.execute(sql`
    SELECT attributes, needs_review FROM variants
    WHERE product_id = ${product.id}
    ORDER BY variant_key
  `)) as unknown as Array<{
    attributes: Record<string, string> | null
    needs_review: boolean
  }>
  // First value wins in variant_key order — deterministic merge.
  const attributes: Record<string, string> = {}
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.attributes ?? {})) {
      if (!(name in attributes)) attributes[name] = value
    }
  }

  // Matched photos (EC-072), ordered with the app's photo listing. When
  // storage is configured the bytes are downloaded here so the strong-tier
  // provider can send them as real image content parts; `photoCount` stays
  // derived from the matched rows either way.
  const photoRows = (await db.execute(sql`
    SELECT f.id AS file_id, f.object_key, f.filename, f.content_type
    FROM product_photos pp
    JOIN import_files f ON f.id = pp.import_file_id
    WHERE pp.product_id = ${product.id}
    ORDER BY f.filename
  `)) as unknown as Array<{
    file_id: string
    object_key: string
    filename: string
    content_type: string | null
  }>
  const photoCount = photoRows.length
  const photos: EnrichPhoto[] = []
  if (storage !== undefined) {
    for (const row of photoRows) {
      photos.push({
        fileId: row.file_id,
        filename: row.filename,
        contentType: row.content_type,
        data: await photoBytes(storage, row.object_key),
      })
    }
  }

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
    ...(photos.length > 0 ? { photos } : {}),
    messiness: messinessScore(
      product,
      variants.length,
      variants.some((variant) => variant.needs_review),
      photoCount
    ),
    sourceRows: memberRows.map((row) => row.row_index),
    ...(sourceRowValues !== undefined ? { sourceRowValues } : {}),
  }

  const enrichStartedAt = Date.now()
  // Per-row routing (spec #12): THIS product's enrich-time photo-aware
  // score picks the model tier — never the Job's plan-time stamp, which
  // only steers the Pause claim gate.
  const call = await registry.run(routingTierFor(input.messiness), (provider) =>
    provider.enrich(input)
  )
  const enrichDurationMs = Date.now() - enrichStartedAt

  const effective = await upsertEnrichment(
    db,
    storeId,
    importId,
    product.id,
    call.value,
    input.messiness
  )
  // Gating reads the post-merge state: reasons the merchant already answered
  // with a manual edit were dropped by the upsert, so they no longer flag.
  if (effective.status === "needs_review") {
    await gateNeedsReview(db, product, effective.reviewReasons)
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
    costMicros: costMicrosFor(call.usage),
    durationMs: enrichDurationMs,
  })
}

/**
 * Idempotent enrichment upsert (ADR-0003) with Origin precedence (GLOSSARY:
 * Origin — a manual field always wins over later AI output). On conflict the
 * merchant-edited fields — `field_origins` key = `manual` — keep their value,
 * confidence and origin; every other field takes the new AI output and its
 * confidence. Review reasons about manual fields are dropped, and the
 * effective status recomputes from the kept reasons: a product whose only
 * flagged fields the merchant already rewrote is no longer Needs Review.
 *
 * The whole merge happens inside the ON CONFLICT clause so a redelivered Job
 * converges atomically — no read-then-write window. Every SET fragment
 * references its columns directly: drizzle's conflict builder drops columns
 * that arrive inside nested sql templates.
 */
async function upsertEnrichment(
  db: Database,
  storeId: string,
  importId: string,
  productId: string,
  value: EnrichmentResult,
  messiness: number
): Promise<EnrichmentUpsert> {
  const [row] = await db
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
      messiness,
    })
    .onConflictDoUpdate({
      target: productEnrichments.productId,
      set: {
        title: sql`CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'title', 'ai') = 'manual'
                   THEN ${productEnrichments.title} ELSE EXCLUDED.title END`,
        handle: sql`CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'handle', 'ai') = 'manual'
                    THEN ${productEnrichments.handle} ELSE EXCLUDED.handle END`,
        description: sql`CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'description', 'ai') = 'manual'
                          THEN ${productEnrichments.description} ELSE EXCLUDED.description END`,
        category: sql`CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'category', 'ai') = 'manual'
                      THEN ${productEnrichments.category} ELSE EXCLUDED.category END`,
        tags: sql`CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'tags', 'ai') = 'manual'
                  THEN ${productEnrichments.tags} ELSE EXCLUDED.tags END`,
        attributes: sql`CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'attributes', 'ai') = 'manual'
                        THEN ${productEnrichments.attributes} ELSE EXCLUDED.attributes END`,
        // EXCLUDED's per-key confidences, overlaid with the stored values of
        // manual fields (the merchant's score is part of what wins). Pure
        // jsonb expressions: a FROM-subquery cannot correlate the target row
        // inside DO UPDATE SET.
        confidence: sql`
          EXCLUDED.confidence
            || jsonb_strip_nulls(jsonb_build_object('title',
                 CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'title', 'ai') = 'manual'
                      THEN ${productEnrichments.confidence} -> 'title' END))
            || jsonb_strip_nulls(jsonb_build_object('handle',
                 CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'handle', 'ai') = 'manual'
                      THEN ${productEnrichments.confidence} -> 'handle' END))
            || jsonb_strip_nulls(jsonb_build_object('description',
                 CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'description', 'ai') = 'manual'
                      THEN ${productEnrichments.confidence} -> 'description' END))
            || jsonb_strip_nulls(jsonb_build_object('category',
                 CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'category', 'ai') = 'manual'
                      THEN ${productEnrichments.confidence} -> 'category' END))
            || jsonb_strip_nulls(jsonb_build_object('tags',
                 CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'tags', 'ai') = 'manual'
                      THEN ${productEnrichments.confidence} -> 'tags' END))
            || jsonb_strip_nulls(jsonb_build_object('attributes',
                 CASE WHEN COALESCE(${productEnrichments.fieldOrigins} ->> 'attributes', 'ai') = 'manual'
                      THEN ${productEnrichments.confidence} -> 'attributes' END))`,
        // Manual origins survive; AI-produced origins reset (absent = 'ai').
        fieldOrigins: sql`
          COALESCE((SELECT jsonb_object_agg(fo.key, fo.value)
            FROM jsonb_each(${productEnrichments.fieldOrigins}) AS fo
            WHERE fo.value #>> '{}' = 'manual'), '{}'::jsonb)`,
        status: sql`
          CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(EXCLUDED.review_reasons) AS r
            WHERE COALESCE(${productEnrichments.fieldOrigins} ->> split_part(r #>> '{}', ':', 1), 'ai') <> 'manual'
          ) THEN 'needs_review'::enrichment_status
          ELSE 'ready'::enrichment_status END`,
        reviewReasons: sql`
          COALESCE((SELECT jsonb_agg(r ORDER BY ord)
            FROM jsonb_array_elements(EXCLUDED.review_reasons)
              WITH ORDINALITY AS t(r, ord)
            WHERE COALESCE(${productEnrichments.fieldOrigins} ->> split_part(t.r #>> '{}', ':', 1), 'ai') <> 'manual'
          ), '[]'::jsonb)`,
        claims: sql`EXCLUDED.claims`,
        sourceRowIndexes: sql`EXCLUDED.source_row_indexes`,
        messiness: sql`EXCLUDED.messiness`,
        updatedAt: new Date(),
      },
    })
    .returning({
      status: productEnrichments.status,
      reviewReasons: productEnrichments.reviewReasons,
    })
  return row!
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
