// Import files — every object an upload contributed to an Import: the sheet,
// individually uploaded photos, and photo ZIP archives. Photos extracted from
// an archive by worker `intake` land here too, keyed by their content hash.
import {
  bigint,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { imports } from "./imports"

export const importFileKind = pgEnum("import_file_kind", [
  "sheet",
  "photo",
  "photo_zip",
])

export const importFiles = pgTable(
  "import_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    kind: importFileKind("kind").notNull(),
    /** Storage key. Photos extracted from a ZIP are re-uploaded under their
     * sha256, so re-running intake converges instead of duplicating. */
    objectKey: text("object_key").notNull(),
    /** Original filename (for archive entries: the entry path). */
    filename: text("filename").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /**
     * sha256 of the bytes. Photos are hashed by worker `intake`, never in the
     * web request (spec: hashing happens in the Worker).
     */
    sha256: text("sha256"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("import_files_object_key").on(t.importId, t.objectKey),
    index("import_files_import_idx").on(t.importId, t.kind),
  ]
)

export type ImportFile = typeof importFiles.$inferSelect
export type NewImportFile = typeof importFiles.$inferInsert
