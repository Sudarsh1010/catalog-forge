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
  productTranslations,
  providerUsage,
  translationMemory,
} from "@workspace/db/schema"
import { TARGET_LOCALES } from "@workspace/pipeline"
import { createLogger } from "@workspace/log"

import type { JobContext, JobHandler } from "../handlers"
import { parseProductBatchKey } from "@workspace/pipeline"
import { healBatchRows } from "../poison"
import {
  routingTierFor,
  routingTierFrom,
  costMicrosFor,
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

/** sha256 of the exact English source text — the translation/TM key. */
function sourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

interface ExistingTranslation {
  field: string
  sourceTextHash: string
  origin: "ai" | "manual"
  outOfDate: boolean
}

async function existingTranslationsOf(
  db: Database,
  productId: string,
  locale: string
): Promise<Map<string, ExistingTranslation>> {
  const rows = await db
    .select({
      field: productTranslations.field,
      sourceTextHash: productTranslations.sourceTextHash,
      origin: productTranslations.origin,
      outOfDate: productTranslations.outOfDate,
    })
    .from(productTranslations)
    .where(
      sql`${productTranslations.productId} = ${productId}::uuid
          AND ${productTranslations.locale} = ${locale}`
    )
  return new Map(rows.map((row) => [row.field, row]))
}

/**
 * Translation Memory lookup (GLOSSARY: Out of Date, ticket #15): identical
 * source text reuses the cached translation and never pays a second
 * provider call.
 */
async function memoryHit(
  db: Database,
  storeId: string,
  locale: string,
  field: TranslateField,
  hash: string
): Promise<string | null> {
  const rows = await db
    .select({ text: translationMemory.text })
    .from(translationMemory)
    .where(
      sql`${translationMemory.storeId} = ${storeId}
          AND ${translationMemory.locale} = ${locale}
          AND ${translationMemory.field} = ${field}
          AND ${translationMemory.sourceTextHash} = ${hash}`
    )
    .limit(1)
  return rows[0]?.text ?? null
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
  // Per-field triage before any provider involvement:
  //   current — a translation already pins this exact source hash: nothing
  //     to do (this is what makes a requeued Batch free for unchanged
  //     Products), and a stale Out-of-Date flag self-heals;
  //   memoized — Translation Memory has the source hash cached: write the
  //     row from the cache, no provider call, no usage;
  //   missing — the only fields the provider call is about.
  const existing = await existingTranslationsOf(db, item.productId, locale)
  const missing: TranslateField[] = []
  for (const field of Object.keys(item.fields) as TranslateField[]) {
    const hash = sourceHash(item.fields[field]!)
    const row = existing.get(field)
    if (row && row.sourceTextHash === hash) {
      // The English source is back in sync with this translation.
      if (row.outOfDate) {
        await db
          .update(productTranslations)
          .set({ outOfDate: false, updatedAt: new Date() })
          .where(
            sql`${productTranslations.productId} = ${item.productId}::uuid
                AND ${productTranslations.locale} = ${locale}
                AND ${productTranslations.field} = ${field}`
          )
      }
      continue
    }
    const cached = await memoryHit(db, storeId, locale, field, hash)
    if (cached !== null) {
      await upsertTranslation(
        db,
        storeId,
        importId,
        item,
        locale,
        field,
        cached,
        hash
      )
      continue
    }
    missing.push(field)
  }

  // Every field was current or memoized: no provider call, no usage row.
  if (missing.length === 0) return

  const call = await registry.run(
    tier ?? routingTierFor(item.messiness),
    (provider) =>
      provider.translate({
        locale,
        fields: Object.fromEntries(
          missing.map((field) => [field, item.fields[field]!])
        ) as Partial<Record<TranslateField, string>>,
        brand: item.brand,
        protectedTokens: item.protectedTokens,
      })
  )

  // EC-088: fields whose "translation" equals the source are no-ops — the
  // provider had nothing to do. Only changed fields land; if none changed,
  // the call cost nothing.
  const changed = missing.filter(
    (field) => call.value.fields[field] !== item.fields[field]
  )
  for (const field of changed) {
    await upsertTranslation(
      db,
      storeId,
      importId,
      item,
      locale,
      field,
      call.value.fields[field]!,
      sourceHash(item.fields[field]!)
    )
    // Cache the fresh AI output so identical source text never re-pays.
    await db
      .insert(translationMemory)
      .values({
        storeId,
        locale,
        field,
        sourceTextHash: sourceHash(item.fields[field]!),
        text: call.value.fields[field]!,
        providerId: call.usage.providerId,
        model: call.usage.model,
      })
      .onConflictDoUpdate({
        target: [
          translationMemory.storeId,
          translationMemory.locale,
          translationMemory.field,
          translationMemory.sourceTextHash,
        ],
        set: { text: sql`EXCLUDED.text`, updatedAt: new Date() },
      })
  }
  if (changed.length === 0) return

  await db.insert(providerUsage).values({
    storeId,
    importId,
    productId: item.productId,
    operation: "translate",
    providerId: call.usage.providerId,
    model: call.usage.model,
    tokensIn: call.usage.tokensIn,
    tokensOut: call.usage.tokensOut,
    costMicros: costMicrosFor(call.usage),
  })
}

async function upsertTranslation(
  db: Database,
  storeId: string,
  importId: string,
  item: BatchItem,
  locale: (typeof TARGET_LOCALES)[number],
  field: TranslateField,
  text: string,
  sourceTextHash: string
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
      sourceTextHash,
      origin: "ai",
      // Fresh AI output of the current source is current by definition.
      outOfDate: false,
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
        outOfDate: sql`false`,
        updatedAt: new Date(),
      },
      setWhere: sql`product_translations.origin <> 'manual'`,
    })
}
