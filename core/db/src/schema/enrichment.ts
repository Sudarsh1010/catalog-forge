// Enrichment & translation output — the `enrich` and `translate` Stage
// projections, plus the per-call usage accounting (spec: usage rows so cost
// aggregation has real shape from day one).
//
// Enrichment matches the brief's JSON shape per Product (title, handle,
// description, category, tags, attributes, per-field Confidence, status,
// Claims, source rows); translations are per (Product, locale, field) with
// `source_text_hash` and `origin` (spec: Schema). Claims are stored, not
// merged into prose, because a Claim always carries its source pointer
// (GLOSSARY: Claim) — and the Demo Mode stub writes none (EC-075).
//
// Idempotency (ADR-0003): enrichment upserts on the Product, translations on
// (Product, locale, field) — a redelivered Job converges, never appends.
// Usage rows are the documented at-least-once exception: one row per real
// provider call, so a retried Job prices the duplicate call it really made.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { imports } from "./imports"
import { products } from "./products"

/** Terminal quality state of one enrichment run (GLOSSARY: Needs Review). */
export const enrichmentStatus = pgEnum("enrichment_status", [
  "ready",
  "needs_review",
])

/** Who produced a translation (GLOSSARY: Origin) — manual always wins. */
export const translationOrigin = pgEnum("translation_origin", ["ai", "manual"])

/** Which provider operation a usage row prices. */
export const providerOperation = pgEnum("provider_operation", [
  "enrich",
  "translate",
])

/**
 * One Product's structured enrichment. `product_id` is unique: Products
 * belong to one Import, so the enrichment identity IS the Product.
 */
export const productEnrichments = pgTable(
  "product_enrichments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Storefront handle: slugified title + natural-key-hash suffix. */
    handle: text("handle").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    attributes: jsonb("attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** Per-field Confidence 0–100 (GLOSSARY: Confidence). */
    confidence: jsonb("confidence").$type<Record<string, number>>().notNull(),
    /**
     * Per-field Origin (GLOSSARY: Origin): who produced each enriched field.
     * A `manual` field is the merchant's edit — a later enrich re-run keeps
     * its value, confidence and origin and never lets AI output clobber it.
     * Absent key = `ai`.
     */
    fieldOrigins: jsonb("field_origins")
      .$type<Record<string, "ai" | "manual">>()
      .notNull()
      .default({}),
    status: enrichmentStatus("status").notNull(),
    /** Extracted assertions with source pointers; [] — the stub invents none. */
    claims: jsonb("claims")
      .$type<
        Array<{ text: string; sourceRowIndex: number; sourceColumn?: string }>
      >()
      .notNull()
      .default([]),
    /** Why gating flagged the Product; empty when `ready`. */
    reviewReasons: jsonb("review_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 1-based Sheet Row indexes the Product was grouped from. */
    sourceRowIndexes: jsonb("source_row_indexes")
      .$type<number[]>()
      .notNull()
      .default([]),
    /** Messiness Score 0–100 that routed this Product's calls (GLOSSARY). */
    messiness: integer("messiness").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotent enrich: one enrichment per Product (ADR-0003).
    uniqueIndex("product_enrichments_product_key").on(t.productId),
    index("product_enrichments_import_idx").on(t.importId),
  ]
)

export type ProductEnrichment = typeof productEnrichments.$inferSelect
export type NewProductEnrichment = typeof productEnrichments.$inferInsert

/**
 * One localized field of one Product (spec: Schema). `source_text_hash`
 * pins the English source the translation was made from; `out_of_date`
 * flips when that source changes (flows beyond the initial write are later
 * scope — the column exists from day one so staleness is expressible).
 */
export const productTranslations = pgTable(
  "product_translations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Target locale from `TARGET_LOCALES` (`de` | `fr`). */
    locale: text("locale").notNull(),
    /** Enriched field name (`title` | `description` | `category`). */
    field: text("field").notNull(),
    /** The translated display text. */
    text: text("text").notNull(),
    /** sha256 of the exact source text this translation was made from. */
    sourceTextHash: text("source_text_hash").notNull(),
    origin: translationOrigin("origin").notNull().default("ai"),
    outOfDate: boolean("out_of_date").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotent translate: one row per (Product, locale, field) (ADR-0003).
    uniqueIndex("product_translations_field_key").on(
      t.productId,
      t.locale,
      t.field
    ),
    index("product_translations_import_idx").on(t.importId, t.locale),
  ]
)

export type ProductTranslation = typeof productTranslations.$inferSelect
export type NewProductTranslation = typeof productTranslations.$inferInsert

/**
 * One AI provider call's usage (spec: usage rows per call, synthetic in Demo
 * Mode). Costs aggregate by Import and by Product; a retried Job legitimately
 * appends another row — the duplicate call really happened (ADR-0003).
 */
export const providerUsage = pgTable(
  "provider_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** The Product the call was about (`null` only if it was later removed). */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    operation: providerOperation("operation").notNull(),
    /** Registered provider id (e.g. `stub`) and its model string. */
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    tokensIn: integer("tokens_in").notNull(),
    tokensOut: integer("tokens_out").notNull(),
    /** Synthetic cost in micro-currency units (1e-6) — never a float. */
    costMicros: integer("cost_micros").notNull(),
    /** Wall-clock duration of the provider call, ms (Metrics speed view). */
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Cost aggregation by Import and by Product.
    index("provider_usage_import_idx").on(t.importId),
    index("provider_usage_product_idx").on(t.productId),
  ]
)

export type ProviderUsageRow = typeof providerUsage.$inferSelect
export type NewProviderUsageRow = typeof providerUsage.$inferInsert
