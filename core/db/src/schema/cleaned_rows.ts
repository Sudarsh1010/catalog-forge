// Clean Stage output — the typed cleaned projection of Sheet Rows plus the
// per-Import column plan the clean Stage's Jobs execute against.
//
// Raw rows stay immutable in `sheet_rows` (GLOSSARY: Sheet Row); everything
// here is derived and rebuildable. Idempotency (ADR-0003): both tables upsert
// on their natural keys, so re-running the Stage converges, never appends.
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

import { sql } from "drizzle-orm"

import { imports } from "./imports"

/**
 * One cleaned cell, positioned by column index (aligned with the Import's
 * `sheet_header` and the raw cell array). `null` marks an absent/blank cell.
 *
 * Money is integer cents plus an ISO-4217 code — never a float (EC-021).
 * Quantities are canonical metric integers (`mm` | `g` | `ml`). Text carries
 * the display value and an NFC match key (EC-053).
 */
export type CleanedCell =
  | { kind: "text"; value: string; key: string }
  | { kind: "html"; value: string }
  | { kind: "price"; cents: number; currency: string }
  | {
      kind: "quantity"
      /** Canonical metric integer in `unit` (mm | g | ml). */
      value: number
      unit: "mm" | "g" | "ml"
      /** The source text, preserved for display and audit. */
      original: string
    }
  | { kind: "unparseable"; value: string }

/**
 * Per-row cleaning flags/issues. Queryable via JSONB containment, e.g.
 * `flags @> '[{"code":"price_locale_ambiguous"}]'` — the feed for the
 * Messiness Score and Needs Review. Every flag cites its EC id from
 * `edge-cases.md` (or `null` when purely informational).
 */
export interface CleanedFlag {
  /** Edge-case id from `edge-cases.md`, e.g. "EC-038". */
  ec: string | null
  /** Stable machine code, e.g. "price_locale_ambiguous". */
  code: string
  /** 0-based column index the flag is about (-1 when row-level). */
  columnIndex: number
  /** Human-readable reason (surfaces in Needs Review). */
  message: string
}

/**
 * The clean Stage's per-column decisions, computed once at plan time by a
 * deterministic scan of the raw rows (plan-then-execute, ADR-0002): chunk
 * Jobs are independent and may run concurrently or out of order, so all
 * per-column inference (locale majority vote, currency, header hints) happens
 * up front and is stored — never re-derived per chunk.
 */
export interface CleanColumnPlan {
  /** 0-based column index; aligns with `sheet_header` / raw cell arrays. */
  index: number
  header: string
  kind: "price" | "quantity" | "text"
  /**
   * Winning decimal convention from the majority vote across the column's
   * rows: `de` (`1.299,00`), `en` (`1,299.00`), or `null` when the column
   * carries no decidable signal (all integers, or a tie — EC-038).
   */
  decimalLocale: "de" | "en" | null
  /**
   * Column currency from symbol/header votes, or `null` when undecidable —
   * cells then fall back to the documented default with an EC-040 flag.
   */
  currency: string | null
  /** True when `currency` was defaulted, not observed (EC-040). */
  currencyAssumed: boolean
  /**
   * Quantity columns: the unit carried by the header ("Länge (cm)" → `cm`,
   * EC-026) — the default for cells without an explicit unit. `null` when
   * the header carries none.
   */
  defaultUnit?: string | null
}

/** One Import's clean plan (planned up front when the Stage begins). */
export const cleanPlans = pgTable("clean_plans", {
  importId: uuid("import_id")
    .primaryKey()
    .references(() => imports.id, { onDelete: "cascade" }),
  /** Per-column decisions, one entry per header column, in order. */
  columns: jsonb("columns").$type<CleanColumnPlan[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type CleanPlan = typeof cleanPlans.$inferSelect
export type NewCleanPlan = typeof cleanPlans.$inferInsert

/** The typed cleaned projection of one Sheet Row (GLOSSARY: Batch output). */
export const cleanedRows = pgTable(
  "cleaned_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** 1-based data-row index; mirrors `sheet_rows.row_index`. */
    rowIndex: integer("row_index").notNull(),
    /** Cleaned cells, positionally aligned with the raw cell array. */
    values: jsonb("values").$type<Array<CleanedCell | null>>().notNull(),
    /** Per-row flags/issues — the Messiness Score / Needs Review feed. */
    flags: jsonb("flags")
      .$type<CleanedFlag[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Row identity + idempotent clean: re-running a chunk upserts, never appends.
    uniqueIndex("cleaned_rows_identity_key").on(t.importId, t.rowIndex),
    index("cleaned_rows_import_idx").on(t.importId, t.rowIndex),
    // Flags must be queryable (Messiness Score, Needs Review feeds).
    index("cleaned_rows_flags_idx").using("gin", t.flags),
  ]
)

export type CleanedRow = typeof cleanedRows.$inferSelect
export type NewCleanedRow = typeof cleanedRows.$inferInsert
