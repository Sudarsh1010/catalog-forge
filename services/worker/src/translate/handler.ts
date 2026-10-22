/**
 * The `translate` Stage handler: one Job translates one deterministic
 * product Batch into ONE target locale (product-batch × locale, GLOSSARY:
 * Batch). Reads the enrichment (guaranteed complete — the stage gate keeps
 * translate unclaimable until every enrich Batch finished, EC-123), masks
 * nothing itself: the provider owns generation, and the stub's masking lets
 * placeholders, HTML tags, numbers+units and never-translate tokens survive
 * the round-trip verbatim (EC-089/EC-090), post-validated per call (EC-081).
 *
 * Idempotent (ADR-0003): translation rows upsert on (Product, locale,
 * field) and never overwrite a manual Origin (GLOSSARY: Origin). A
 * source-locale no-op produces nothing and costs nothing (EC-088). Usage
 * rows land per real call; retries append by design.
 */
import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import {
  imports,
  productEnrichments,
  productTranslations,
  providerUsage,
} from "@workspace/db/schema"
import { TARGET_LOCALES } from "@workspace/pipeline"
import { createLogger } from "@workspace/log"

import type { JobContext, JobHandler } from "../handlers"
import { parseProductBatchKey } from "../media/plan"
import { healBatchRows } from "../poison"
import {
  routingTierFor,
  routingTierFrom,
  syntheticCostMicros,
  type ProviderRegistry,
  type RoutingTier,
  type TranslateField,
} from "../provider"

const log = createLogger({ service: "worker:translate" })

export interface TranslateDeps {
  registry: ProviderRegistry
}

export function createTranslateHandler(deps: TranslateDeps): JobHandler {
  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx
    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `translate: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op

    // A translate Batch key carries its locale; anything else is poison.
    const range = parseProductBatchKey(job.batchKey)
    if (
      !range ||
      range.locale === null ||
      !(TARGET_LOCALES as readonly string[]).includes(range.locale)
    ) {
      throw new Error(
        `translate: unparseable product-batch key "${job.batchKey}"`
      )
    }
    const locale = range.locale as (typeof TARGET_LOCALES)[number]

    const batch = await loadBatch(db, job.importId, range.start, range.end)
    // The tier travels on the Job (stamped at plan time); the per-item
    // messiness recorded at enrich time is the fallback.
    const tier = routingTierFrom(job.routingTier)
    for (const item of batch) {
      await translateProduct(
        db,
        deps.registry,
        job.storeId,
        job.importId,
        item,
        locale,
        tier
      )
    }
    // A retry that succeeded heals the poison quarantine (EC-122).
    await healBatchRows(db, job.importId, job.batchKey)

    log.info(`translate batch completed`, {
      importId: job.importId,
      jobId: job.id,
      batchKey: job.batchKey,
      locale,
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

interface BatchItem {
  productId: string
  brand: string | null
  /** Messiness recorded at enrich time — routes the tier (GLOSSARY). */
  messiness: number
  fields: Partial<Record<TranslateField, string>>
  protectedTokens: string[]
}

/**
 * The Batch in the planner's deterministic order (ordinal in
 * `natural_key_hash` — ADR-0002), joined with its enrichment. Products whose
 * enrichment never landed (their enrich Batch died terminally) are skipped:
 * the ledger carries the failure, translation has nothing to localize.
 */
async function loadBatch(
  db: Database,
  importId: string,
  start: number,
  end: number
): Promise<BatchItem[]> {
  const rows = (await db.execute(sql`
    SELECT p.id AS product_id, p.brand, e.messiness,
           e.title, e.description, e.category
    FROM products p
    LEFT JOIN product_enrichments e ON e.product_id = p.id
    WHERE p.import_id = ${importId}
    ORDER BY p.natural_key_hash
    OFFSET ${start - 1} LIMIT ${end - start + 1}
  `)) as unknown as Array<{
    product_id: string
    brand: string | null
    messiness: number | null
    title: string | null
    description: string | null
    category: string | null
  }>

  const items: BatchItem[] = []
  for (const row of rows) {
    if (row.messiness === null) continue // no enrichment: nothing to localize
    const fields: Partial<Record<TranslateField, string>> = {}
    if (row.title?.trim()) fields.title = row.title
    if (row.description?.trim()) fields.description = row.description
    if (row.category?.trim()) fields.category = row.category
    if (Object.keys(fields).length === 0) continue
    items.push({
      productId: row.product_id,
      brand: row.brand,
      messiness: row.messiness,
      fields,
      protectedTokens: await protectedTokensOf(db, row.product_id),
    })
  }
  return items
}

/** Never-translate identity evidence: variant SKUs and GTINs (EC-089). */
async function protectedTokensOf(
  db: Database,
  productId: string
): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT sku, gtin FROM variants
    WHERE product_id = ${productId} AND (sku IS NOT NULL OR gtin IS NOT NULL)
    ORDER BY variant_key
  `)) as unknown as Array<{ sku: string | null; gtin: string | null }>
  const tokens = rows
    .flatMap((row) => [row.sku, row.gtin])
    .filter(
      (token): token is string => token !== null && token.trim().length > 0
    )
  return [...new Set(tokens)]
}

async function translateProduct(
  db: Database,
  registry: ProviderRegistry,
  storeId: string,
  importId: string,
  item: BatchItem,
  locale: (typeof TARGET_LOCALES)[number],
  tier: RoutingTier | null
): Promise<void> {
  const call = await registry.run(
    tier ?? routingTierFor(item.messiness),
    (provider) =>
      provider.translate({
        locale,
        fields: item.fields,
        brand: item.brand,
        protectedTokens: item.protectedTokens,
      })
  )

  // EC-088: fields whose "translation" equals the source are no-ops — the
  // provider had nothing to do. Only changed fields land; if none changed,
  // the call cost nothing.
  const changed = (Object.keys(item.fields) as TranslateField[]).filter(
    (field) => call.value.fields[field] !== item.fields[field]
  )
  if (changed.length === 0) return

  for (const field of changed) {
    await upsertTranslation(
      db,
      storeId,
      importId,
      item,
      locale,
      field,
      call.value.fields[field]!
    )
  }
  await db.insert(providerUsage).values({
    storeId,
    importId,
    productId: item.productId,
    operation: "translate",
    providerId: call.usage.providerId,
    model: call.usage.model,
    tokensIn: call.usage.tokensIn,
    tokensOut: call.usage.tokensOut,
    costMicros: syntheticCostMicros(call.usage),
  })
}

async function upsertTranslation(
  db: Database,
  storeId: string,
  importId: string,
  item: BatchItem,
  locale: (typeof TARGET_LOCALES)[number],
  field: TranslateField,
  text: string
): Promise<void> {
  await db
    .insert(productTranslations)
    .values({
      storeId,
      importId,
      productId: item.productId,
      locale,
      field,
      text,
      // Pins the exact English source (GLOSSARY: Out of Date).
      sourceTextHash: createHash("sha256")
        .update(item.fields[field]!, "utf8")
        .digest("hex"),
      origin: "ai",
    })
    // A manual Origin always wins over later AI output (GLOSSARY).
    .onConflictDoUpdate({
      target: [
        productTranslations.productId,
        productTranslations.locale,
        productTranslations.field,
      ],
      set: {
        text: sql`EXCLUDED.text`,
        sourceTextHash: sql`EXCLUDED.source_text_hash`,
        updatedAt: new Date(),
      },
      setWhere: sql`product_translations.origin <> 'manual'`,
    })
}
