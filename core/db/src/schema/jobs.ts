// Jobs — the durable Work Queue (ADR-0001).
//
// One row per claimable unit of work: a Stage applied to one Batch
// (GLOSSARY: Job, Batch). The worker owns this table's machinery (claiming,
// leasing, attempts); the web app never writes it (ADR-0004).
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

export const jobStatus = pgEnum("job_status", [
  /** Awaiting claim. */
  "pending",
  /** Held under a live lease by a worker. */
  "running",
  /** Finished successfully (terminal for this ticket). */
  "completed",
  /** Exhausted attempts — terminal Failed, retryable from the dashboard later. */
  "failed",
])

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    /** Batch identity: the Import, the Stage, and the deterministic Batch slice. */
    importId: uuid("import_id").notNull(),
    stage: text("stage").notNull(),
    batchKey: text("batch_key").notNull(),
    status: jobStatus("status").notNull().default("pending"),
    /** Execution count; incremented on every claim. 5 = terminal Failed. */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** Lease: who holds the claim and until when (ADR-0003). */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Plan-then-execute: one Job per (Import, Stage, Batch) — ADR-0002.
    uniqueIndex("jobs_batch_identity_key").on(t.importId, t.stage, t.batchKey),
    index("jobs_claim_idx").on(t.status, t.leaseExpiresAt),
  ]
)

export type Job = typeof jobs.$inferSelect
export type NewJob = typeof jobs.$inferInsert
