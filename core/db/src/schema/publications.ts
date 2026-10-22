// Publications — the render-ready, per-locale snapshot of an approved
// Product that the storefront reads (GLOSSARY: Publication, ADR-0005).
//
// Written at approval, never by an Import Stage: approval is the only
// transition into the shopper-visible world, so a Publication's existence
// IS approval — under-review Products are invisible by construction and
// storefront queries join nothing from staging or the work queue. One row
// per (Product, locale); the English row is the source of truth, target
// locales mirror it (missing target locale falls back to English at read
// time). Fields are denormalized copies, so import-time rewrites of
// enrichment/translation tables never contend with shopper reads.
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { products } from "./products"

export const publications = pgTable(
  "publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** `en` (source) or one of `TARGET_LOCALES` (`de` | `fr`). */
    locale: text("locale").notNull(),
    /** Storefront handle: slugified title + natural-key-hash suffix. */
    handle: text("handle").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    attributes: jsonb("attributes")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** Cheapest Variant's price, denormalized as integer cents (EC-021). */
    priceCents: integer("price_cents"),
    priceCurrency: text("price_currency"),
    /** Full purchasable list, copied render-ready from the Variants. */
    variants: jsonb("variants")
      .$type<
        Array<{
          sku: string | null
          gtin: string | null
          priceCents: number | null
          priceCurrency: string | null
          attributes: Record<string, string>
          imageRef: string | null
        }>
      >()
      .notNull()
      .default([]),
    /** Approved product photos, as storage keys (GLOSSARY: Publication). */
    photos: jsonb("photos")
      .$type<Array<{ objectKey: string; filename: string }>>()
      .notNull()
      .default([]),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One render-ready snapshot per Product × locale.
    uniqueIndex("publications_product_locale_key").on(t.productId, t.locale),
    // Handles resolve per locale; the English handle is canonical and the
    // same slug is reused for target locales (fallback keeps one URL).
    uniqueIndex("publications_handle_key").on(t.storeId, t.locale, t.handle),
    // The collection listing's only access path.
    index("publications_store_locale_idx").on(t.storeId, t.locale),
  ]
)

export type Publication = typeof publications.$inferSelect
export type NewPublication = typeof publications.$inferInsert
