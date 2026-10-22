// Provider Pauses — the per-provider throttle state (GLOSSARY: Pause).
//
// One provider throttling ("429" + Retry-After) holds back THAT provider's
// Jobs across ALL Imports; other providers keep working. Imports merely
// surface the Pause (`imports.status = 'paused'` + `paused_until`); this
// table is the fact the claim gate reads. The row exists only while paused —
// automatic resume on schedule deletes it, so "no row" is "not paused".
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const providerPauses = pgTable(
  "provider_pauses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Store isolation from day one (ADR-0006). */
    storeId: text("store_id").notNull(),
    /** Registered provider id (e.g. `stub`) — the throttled party. */
    providerId: text("provider_id").notNull(),
    /** Merchant-visible reason, e.g. the provider fault class. */
    reason: text("reason").notNull(),
    /** When claims for this provider resume — honors Retry-After. */
    resumeAt: timestamp("resume_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One active Pause per provider per store; re-entry extends `resume_at`.
    uniqueIndex("provider_pauses_identity_key").on(t.storeId, t.providerId),
    // Resume scan: expired Pauses to lift.
    index("provider_pauses_resume_idx").on(t.resumeAt),
  ]
)

export type ProviderPause = typeof providerPauses.$inferSelect
export type NewProviderPause = typeof providerPauses.$inferInsert
