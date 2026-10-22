// Re-run requests — a domain fact the Worker adopts (ADR-0004: the app
// writes domain facts and never touches Job machinery).
//
// A Re-run (GLOSSARY) is the merchant's request to redo a Stage's work for
// chosen Products — e.g. enrichment on a handful of rows. The dashboard
// POSTs here (one row per request, carrying the chosen Product ids), and
// the Worker's Sweeper adopts it by requeuing the enrich Jobs whose
// deterministic Batches cover those Products, with reset attempts.
// Adoption deletes the request, so "row present" means "pending adoption";
// re-running an already-running Job is a harmless no-op.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { imports } from "./imports"

export const reruns = pgTable(
  "reruns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** The Stage to redo. Ticket scope: `enrich` (the pipeline's only
     *  merchant-facing re-run today); the column keeps the fact honest as
     *  further Stages grow one. */
    stage: text("stage").notNull().default("enrich"),
    /** The chosen Products; the Worker maps them onto their Batches. */
    productIds: uuid("product_ids").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Sweeper adoption scan: this Import's pending facts, oldest first.
    index("reruns_adoption_idx").on(t.importId, t.createdAt),
  ]
)

export type Rerun = typeof reruns.$inferSelect
export type NewRerun = typeof reruns.$inferInsert
