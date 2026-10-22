// Products & Variants — the `group` Barrier Stage's output (GLOSSARY:
// Product, Variant, Natural Key).
//
// Duplicate prevention is a database guarantee (EC-068): the Natural Key is
// scoped to the Import (the sheet's source — the same supplier code from two
// sources stays two Products, EC-032) and protected by a unique index, with
// upsert semantics in the handler. The readable key travels beside its
// sha256 so dashboards can show identity without recomputing it.
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

import { sql } from "drizzle-orm"

import { imports } from "./imports"

/**
 * Which identity evidence produced the Natural Key: a supplier code (`code`
 * — SKU or GTIN) or the title fallback for rows without one (EC-031 — lower
 * confidence, always flagged Needs Review).
 */
export const productIdentityKind = pgEnum("product_identity_kind", [
  "code",
  "title",
])

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    /** The source sheet this Product was grouped from (EC-032 scope). */
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    identityKind: productIdentityKind("identity_kind").notNull(),
    /** Readable canonical key, e.g. `sku:tp-100` or `title:gießkanne 5 l`. */
    naturalKey: text("natural_key").notNull(),
    /** sha256 of `natural_key` — the dedup identity (EC-068). */
    naturalKeyHash: text("natural_key_hash").notNull(),
    /** Richer-copy-wins display title (EC-061). */
    title: text("title").notNull(),
    brand: text("brand"),
    category: text("category"),
    description: text("description"),
    /** Set only when every Variant agrees on one GTIN; conflicts flag review. */
    gtin: text("gtin"),
    /** Terminal quality state (GLOSSARY: Needs Review), always with a reason. */
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // EC-068: at most one Product per scoped Natural Key — the DB, not app
    // logic, resolves races; the barrier's upserts converge on re-run.
    uniqueIndex("products_natural_key_key").on(
      t.storeId,
      t.importId,
      t.naturalKeyHash
    ),
    index("products_import_idx").on(t.importId),
  ]
)

export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert

/**
 * One purchasable form of a Product: one SKU, one price (GLOSSARY: Variant).
 * Identity within the Product is the canonical Variant key — the normalized
 * supplier code, or the canonical attribute combination for rows without a
 * SKU (EC-064: dedupe on the canonical key, merge attributes).
 */
export const variants = pgTable(
  "variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Readable canonical key, e.g. `sku:tp-100-r` or `attrs:farbe=rot`. */
    variantKey: text("variant_key").notNull(),
    /** sha256 of `variantKey` — the dedup identity within the Product. */
    variantKeyHash: text("variant_key_hash").notNull(),
    /** The supplier code exactly as cleaned (display value). */
    sku: text("sku"),
    gtin: text("gtin"),
    /** Integer cents plus ISO-4217 — never a float (EC-021). */
    priceCents: integer("price_cents"),
    priceCurrency: text("price_currency"),
    /** Variant-axis values by header, display values (EC-063). */
    attributes: jsonb("attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The sheet's image reference cell, verbatim (EC-072). */
    imageRef: text("image_ref"),
    /** First Sheet Row that carried this Variant (audit trail). */
    sourceRowIndex: integer("source_row_index").notNull(),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReason: text("review_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Idempotent grouping (ADR-0003): re-running the barrier upserts, never appends.
    uniqueIndex("variants_identity_key").on(t.productId, t.variantKeyHash),
    index("variants_import_idx").on(t.importId),
  ]
)

export type Variant = typeof variants.$inferSelect
export type NewVariant = typeof variants.$inferInsert
