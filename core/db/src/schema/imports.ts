// Imports — one attempt to turn an uploaded sheet (+ optional photos) into
// catalog products (GLOSSARY: Import). The app writes this table (ADR-0004);
// the worker's Sweeper adopts queued rows and owns everything downstream.
//
// Identity: an Import is identified by the sheet's content hash — re-uploading
// the same file targets the same Import and is a no-op (unique index below).
import {
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

export const importStatus = pgEnum("import_status", [
  /** Written by the app, awaiting Sweeper adoption. */
  "queued",
  /** Adopted; the Stage machinery is in motion. */
  "running",
  /** Held back by a provider Pause; surfaced for the UI (spec: Pause). */
  "paused",
  "completed",
  /** Terminal Failed with a merchant-fixable `failure_reason`. */
  "failed",
])

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    /** sha256 of the sheet's bytes — the Import's identity for dedupe. */
    contentHash: text("content_hash").notNull(),
    /** What the merchant called the file; display only. */
    originalFilename: text("original_filename").notNull(),
    /** `csv` | `xlsx` — picked by cheap extension validation at upload. */
    sheetFormat: text("sheet_format").notNull(),
    /** Storage key of the sheet object uploaded by the web request. */
    sheetObjectKey: text("sheet_object_key").notNull(),
    status: importStatus("status").notNull().default("queued"),
    /** Current pipeline Stage; the fixed order lives in @workspace/pipeline. */
    stage: text("stage").notNull().default("intake"),
    /**
     * Header cells landed by intake. The header is not a Sheet Row — data
     * rows (1-based) live in `sheet_rows`, so ledger counts add up by
     * construction.
     */
    sheetHeader: jsonb("sheet_header").$type<string[]>(),
    /** Data rows landed by intake; `null` until intake completes. */
    rowCount: integer("row_count"),
    /** Why the Import Failed — merchant-fixable, references the EC class. */
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Content-hash dedupe: at most one Import per identical sheet per store.
    uniqueIndex("imports_content_hash_key").on(t.storeId, t.contentHash),
    // Sweeper adoption scan: queued Imports, oldest first.
    index("imports_adoption_idx").on(t.status, t.createdAt),
  ]
)

export type Import = typeof imports.$inferSelect
export type NewImport = typeof imports.$inferInsert
