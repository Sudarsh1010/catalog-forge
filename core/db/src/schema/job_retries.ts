// Dashboard retry requests — a domain fact the Worker adopts (ADR-0004: the
// app writes domain facts and never touches Job machinery).
//
// A poison Job terminated as Failed stays retryable (GLOSSARY: Row Ledger,
// ADR-0003): the dashboard POSTs here (one row per retried Job), and the
// Worker's Sweeper adopts the request by requeuing the Job with reset
// attempts. Adoption deletes the request, so "row present" means "pending
// adoption"; the unique Job index makes double-clicks harmless.
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

import { imports } from "./imports"
import { jobs } from "./jobs"

export const jobRetries = pgTable(
  "job_retries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    importId: uuid("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    /** The terminally Failed Job to requeue with reset attempts. */
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One pending request per Job — a repeated retry click is a no-op.
    uniqueIndex("job_retries_job_key").on(t.jobId),
    // Sweeper adoption scan, oldest first.
    index("job_retries_adoption_idx").on(t.createdAt),
  ]
)

export type JobRetry = typeof jobRetries.$inferSelect
export type NewJobRetry = typeof jobRetries.$inferInsert
