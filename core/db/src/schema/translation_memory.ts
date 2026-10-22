// Translation Memory (GLOSSARY: Out of Date, ticket #15) — the per-source-
// hash cache of AI translations. Keyed on (store, locale, field,
// source_text_hash): identical English source text reuses the cached
// translation and never pays a second provider call. Only AI output is
// cached — a merchant's manual fix is theirs alone and must never leak into
// another Product's AI result (GLOSSARY: Origin — manual always wins).
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const translationMemory = pgTable(
  "translation_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    /** Target locale (`de` | `fr`). */
    locale: text("locale").notNull(),
    /** Enriched field name (`title` | `description` | `category`). */
    field: text("field").notNull(),
    /** sha256 of the exact English source text (the cache key). */
    sourceTextHash: text("source_text_hash").notNull(),
    /** The cached translation of that source text. */
    text: text("text").notNull(),
    /** The provider that produced it (audit: where the cache entry came from). */
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The cache identity: same store, locale, field and source text is the
    // same translation — a redelivered Job converges, never appends.
    uniqueIndex("translation_memory_key").on(
      t.storeId,
      t.locale,
      t.field,
      t.sourceTextHash
    ),
    index("translation_memory_store_idx").on(t.storeId, t.locale),
  ]
)

export type TranslationMemoryRow = typeof translationMemory.$inferSelect
export type NewTranslationMemoryRow = typeof translationMemory.$inferInsert
