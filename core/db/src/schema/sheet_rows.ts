// Sheet Rows — one physical row of the uploaded sheet, recorded exactly as
// the supplier sent it (GLOSSARY: Sheet Row). The immutable unit of source
// truth: everything derived from it can be rebuilt from it. No cleaned
// projection here — that is later Stage machinery's output.
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { imports } from "./imports"

/** A cell exactly as parsed: CSV cells are strings; XLSX cells keep their
 * stored scalar type. No normalization, no typing decisions. */
export type SheetCell = string | number | boolean | null

export const sheetRows = pgTable(
  "sheet_rows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** 1-based data-row index; the header is `imports.sheet_header`. */
    rowIndex: integer("row_index").notNull(),
    /** The row exactly as sent: ordered cell values, nothing cleaned. */
    raw: jsonb("raw").$type<SheetCell[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Identity + idempotent intake: re-running the Stage upserts, never
    // appends. (The unique index doubles as the import scan index — no twin.)
    uniqueIndex("sheet_rows_identity_key").on(t.importId, t.rowIndex),
  ]
)

export type SheetRow = typeof sheetRows.$inferSelect
export type NewSheetRow = typeof sheetRows.$inferInsert
