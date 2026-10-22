// Row Ledger — the accounting that guarantees every Sheet Row of an Import
// ends in exactly one terminal state: Done, Needs Review, or Failed with a
// reason (GLOSSARY: Row Ledger). The only source of "the counts add up to
// the sheet" — never derived from Job bookkeeping (ADR-0003).
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { imports } from "./imports"
import { products, variants } from "./products"

export const rowLedgerState = pgEnum("row_ledger_state", [
  /** Row grouped into its Product cleanly. */
  "done",
  /** Row's Product/Variant carries a conflict or low-confidence identity. */
  "needs_review",
  /** Row could not be grouped — always with a merchant-fixable reason. */
  "failed",
])

export const rowLedger = pgTable(
  "row_ledger",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** 1-based data-row index; one ledger row per `sheet_rows` row. */
    rowIndex: integer("row_index").notNull(),
    state: rowLedgerState("state").notNull(),
    /** The Product the row grouped into (`null` when failed). */
    productId: uuid("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** The Variant the row merged into, when one carries it. */
    variantId: uuid("variant_id").references(() => variants.id, {
      onDelete: "set null",
    }),
    /** Why the row Failed — merchant-fixable, cites the EC class. */
    failureReason: text("failure_reason"),
    /** Edge-case id from `edge-cases.md`, e.g. "EC-031" (`null` when n/a). */
    failureEc: text("failure_ec"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One ledger row per Sheet Row; the barrier's upserts converge on re-run.
    uniqueIndex("row_ledger_identity_key").on(t.importId, t.rowIndex),
    // Dashboard counts: per-Import state breakdown.
    index("row_ledger_import_idx").on(t.importId, t.state),
  ]
)

export type RowLedgerEntry = typeof rowLedger.$inferSelect
export type NewRowLedgerEntry = typeof rowLedger.$inferInsert
