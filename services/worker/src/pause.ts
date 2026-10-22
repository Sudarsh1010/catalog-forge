/**
 * Provider Pauses (GLOSSARY: Pause) — the per-provider throttle state a 429
 * engages. One provider throttling holds back THAT provider's Jobs across
 * ALL Imports; other providers keep working. Imports merely surface the
 * Pause (`status = 'paused'` + `paused_until` — "Paused — resuming in X
 * minutes" for the dashboard); the claim gate reads `provider_pauses`.
 *
 * Resume is automatic on schedule: the Worker's claim tick lifts expired
 * Pauses (the row is deleted — "no row" is "not paused") and flips surfaced
 * Imports back to `running`. No human action anywhere.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"

import { rowsOf } from "./jobs"

export interface ProviderPauseInput {
  storeId: string
  providerId: string
  /** When claims resume — epoch ms (the Worker's injectable clock). */
  resumeAtMs: number
  /** Merchant-visible reason, e.g. the provider fault class. */
  reason: string
}

export interface EnteredPause {
  providerId: string
  /** ISO-8601 resume time (also the `paused` event payload). */
  resumeAt: string
  /** Imports flipped to `paused` by THIS entry — the `paused` event targets. */
  affectedImportIds: string[]
}

/**
 * Enter (or extend) one provider's Pause and surface it on every Import
 * holding that provider's Jobs. One transaction: the pause row and the
 * Import flips appear together, so the claim gate can never hold Jobs for a
 * Pause the dashboard cannot see (or the reverse). Re-entry while paused
 * extends `resume_at` to the later of the two — a fresh Retry-After wins.
 */
export async function enterProviderPause(
  db: Database,
  input: ProviderPauseInput
): Promise<EnteredPause> {
  const resumeAt = new Date(input.resumeAtMs).toISOString()
  return db.transaction(async (tx) => {
    const pauseRows = rowsOf<{ resume_at: string }>(
      await tx.execute(sql`
        INSERT INTO provider_pauses (store_id, provider_id, reason, resume_at)
        VALUES (${input.storeId}, ${input.providerId}, ${input.reason}, ${resumeAt})
        ON CONFLICT (store_id, provider_id) DO UPDATE SET
          resume_at = GREATEST(provider_pauses.resume_at, EXCLUDED.resume_at),
          reason = EXCLUDED.reason,
          updated_at = now()
        RETURNING resume_at::text AS resume_at
      `)
    )
    const effectiveResumeAt = pauseRows[0]!.resume_at
    const affected = rowsOf<{ id: string }>(
      await tx.execute(sql`
        UPDATE imports SET
          status = 'paused',
          paused_until = ${effectiveResumeAt}::timestamptz,
          paused_provider_id = ${input.providerId},
          updated_at = now()
        WHERE status = 'running' AND id IN (
          SELECT import_id FROM jobs
          WHERE store_id = ${input.storeId} AND provider_id = ${input.providerId}
            AND status IN ('pending', 'running')
        )
        RETURNING id
      `)
    )
    return {
      providerId: input.providerId,
      resumeAt: effectiveResumeAt,
      affectedImportIds: affected.map((row) => row.id),
    }
  })
}

export interface ResumedPause {
  importId: string
  providerId: string | null
}

/**
 * Lift every expired Pause and resume the Imports surfacing it. The Import
 * flip is guarded: an Import whose provider is paused AGAIN (a fresh Pause
 * landed between expiry and flip) stays paused. Returns the resumed Imports
 * for logging; the dashboard rebuilds from the Postgres snapshot (the
 * spec's event vocabulary has no `resumed` event — Postgres is the truth).
 */
export async function resumeExpiredPauses(
  db: Database,
  nowMs: number
): Promise<ResumedPause[]> {
  const now = new Date(nowMs).toISOString()
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM provider_pauses WHERE resume_at <= ${now}::timestamptz
    `)
    const resumed = rowsOf<{ id: string; paused_provider_id: string | null }>(
      await tx.execute(sql`
        UPDATE imports SET
          status = 'running',
          paused_until = NULL,
          paused_provider_id = NULL,
          updated_at = now()
        WHERE status = 'paused' AND NOT EXISTS (
          SELECT 1 FROM provider_pauses pp
          WHERE pp.store_id = imports.store_id
            AND pp.provider_id = imports.paused_provider_id
        )
        RETURNING id, paused_provider_id
      `)
    )
    return resumed.map((row) => ({
      importId: row.id,
      providerId: row.paused_provider_id,
    }))
  })
}
