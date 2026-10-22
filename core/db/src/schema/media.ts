// Media matching output — the `match-media` Stage attaches uploaded photos
// to Products by ranked strategies (EC-072); anything unmatched becomes a
// Parked Photo with a reason (GLOSSARY: Parked Photo) — never silently
// dropped. Both tables upsert on (Import, file), so re-runs converge.
import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { imports } from "./imports"
import { importFiles } from "./import_files"
import { products, variants } from "./products"

/** The ranked strategy that decided the match (EC-072). */
export const photoMatchStrategy = pgEnum("photo_match_strategy", [
  /** Exact SKU/GTIN token in the file's base name. */
  "sku",
  "gtin",
  /** Normalized-title match against the Product title. */
  "title",
  /** SKU/GTIN token in a subfolder segment of the entry path. */
  "subfolder",
])

/** One photo's best match — one row per uploaded photo per Import. */
export const productPhotos = pgTable(
  "product_photos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** The uploaded photo (loose file or ZIP entry). */
    importFileId: uuid("import_file_id")
      .notNull()
      .references(() => importFiles.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Set when the filename pinned one Variant (attribute/sku evidence). */
    variantId: uuid("variant_id").references(() => variants.id, {
      onDelete: "set null",
    }),
    matchedVia: photoMatchStrategy("matched_via").notNull(),
    /** The token that decided the match (display form, for the dashboard). */
    matchedToken: text("matched_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Ranked assignment: exactly one best match per photo (re-runs upsert).
    uniqueIndex("product_photos_file_identity_key").on(
      t.importId,
      t.importFileId
    ),
    index("product_photos_product_idx").on(t.productId),
  ]
)

export type ProductPhoto = typeof productPhotos.$inferSelect
export type NewProductPhoto = typeof productPhotos.$inferInsert

/** An uploaded photo that matched no Product — surfaced with a reason. */
export const parkedPhotos = pgTable(
  "parked_photos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    importFileId: uuid("import_file_id")
      .notNull()
      .references(() => importFiles.id, { onDelete: "cascade" }),
    /** Merchant-fixable reason, cites the EC class where one applies. */
    reason: text("reason").notNull(),
    /** Edge-case id from `edge-cases.md`, e.g. "EC-072". */
    ec: text("ec"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("parked_photos_file_identity_key").on(
      t.importId,
      t.importFileId
    ),
    index("parked_photos_import_idx").on(t.importId),
  ]
)

export type ParkedPhoto = typeof parkedPhotos.$inferSelect
export type NewParkedPhoto = typeof parkedPhotos.$inferInsert
