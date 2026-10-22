/**
 * The match-media Stage's planner (ADR-0002 plan-then-execute) — the
 * barrier's fan-out: when the group Barrier Job completes, this plans
 *
 *   1. the match-media Job (one per Import — matching is a second barrier:
 *      subfolder hints need to see every photo and every Product), and
 *   2. the enrich Batches (product-batches) and translate Batches
 *      (product-batch × locale) whose HANDLERS belong to the next ticket —
 *      the boundaries are planned here so they are deterministic from day
 *      one and restarts re-discover identical Batches.
 *
 * Batch membership is the Product's ordinal in `natural_key_hash` order —
 * content-deterministic, so a re-plan derives identical boundaries. All
 * inserts are conflict-nothing on the (Import, Stage, Batch) identity.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import { TARGET_LOCALES } from "@workspace/pipeline"

import type { StagePlanTarget } from "../stages"
import { routingTierFor, type RoutingTier } from "../provider/port"

/** The single deterministic Batch identity of the media barrier. */
export const MEDIA_BATCH_KEY = "media"

/** Products per enrich/translate Batch (production constant). */
export const ENRICH_BATCH_SIZE = 100

export interface PlanMatchMediaOptions {
  /** Tests shrink the constant to exercise multi-Batch Imports quickly. */
  batchSize?: number
  /**
   * Resolves the provider serving a routing tier — Jobs are stamped with it
   * at plan time (spec: "routing tiers are assigned to Jobs at plan time via
   * the Messiness Score"), so the Pause claim gate holds exactly those Jobs.
   * Omitted (tests of earlier tickets): Jobs stay provider-less and claim
   * regardless of Pauses.
   */
  providerForTier?: (tier: RoutingTier) => string
}

/** Deterministic enrich Batch identity: 1-based inclusive product ordinal range. */
export function enrichBatchKey(start: number, end: number): string {
  return `products-${String(start).padStart(6, "0")}-${String(end).padStart(6, "0")}`
}

/** Translate Batch identity: the product range times one target locale. */
export function translateBatchKey(
  start: number,
  end: number,
  locale: string
): string {
  return `${enrichBatchKey(start, end)}:${locale}`
}

/**
 * Parse a product-batch key back to its inclusive range and (for translate)
 * its locale. `locale` is `null` for enrich keys.
 */
export function parseProductBatchKey(
  key: string
): { start: number; end: number; locale: string | null } | null {
  const match = /^products-(\d{6})-(\d{6})(?::([a-z]{2}))?$/.exec(key)
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    locale: match[3] ?? null,
  }
}

export async function planMatchMediaStage(
  db: Database,
  target: StagePlanTarget,
  options?: PlanMatchMediaOptions
): Promise<void> {
  const batchSize = options?.batchSize ?? ENRICH_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`match-media plan: invalid batch size ${batchSize}`)
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO jobs (store_id, import_id, stage, batch_key)
      VALUES (${target.storeId}, ${target.importId}, 'match-media', ${MEDIA_BATCH_KEY})
      ON CONFLICT (import_id, stage, batch_key) DO NOTHING
    `)

    // Product ordinals in natural-key-hash order: same products, same
    // Batches — across re-plans and restarts (ADR-0002). Each product's
    // Messiness Score is recomputed with EXACTLY the enrich handler's
    // `messinessScore` formula minus photos (media matching has not run
    // yet — the score finalizes at enrich time; the plan-time copy only
    // picks the Batch's routing tier, which Demo Mode treats identically).
    const rows = (await tx.execute(sql`
      WITH scored AS (
        SELECT p.id, p.identity_kind, p.description, p.category, p.brand, p.gtin,
               ROW_NUMBER() OVER (ORDER BY p.natural_key_hash) AS ordinal
        FROM products p
        WHERE p.import_id = ${target.importId}
      )
      SELECT s.ordinal, (
        (s.identity_kind = 'title')::int * 30
        + (CASE WHEN COALESCE(s.description, '') = '' THEN 20 ELSE 0 END)
        + (CASE WHEN COALESCE(s.category, '') = '' THEN 15 ELSE 0 END)
        + (CASE WHEN COALESCE(s.brand, '') = '' THEN 10 ELSE 0 END)
        + (CASE WHEN s.gtin IS NULL THEN 10 ELSE 0 END)
        + (CASE WHEN EXISTS (
             SELECT 1 FROM variants v
             WHERE v.product_id = s.id AND v.needs_review
           ) THEN 15 ELSE 0 END)
        + LEAST((SELECT count(*) FROM variants v WHERE v.product_id = s.id), 4) * 2
      )::int AS messiness
      FROM scored s
      ORDER BY s.ordinal
    `)) as unknown as Array<{ ordinal: number; messiness: number }>
    const count = rows.length

    for (let start = 1, ordinal = 0; ordinal < count; ordinal += batchSize) {
      const end = Math.min(start + batchSize - 1, count)
      // The Batch's tier: its neediest product routes the whole Batch.
      const tier = routingTierFor(
        Math.max(...rows.slice(start - 1, end).map((row) => row.messiness), 0)
      )
      const providerId = options?.providerForTier?.(tier) ?? null
      await tx.execute(sql`
        INSERT INTO jobs (store_id, import_id, stage, batch_key, provider_id, routing_tier)
        VALUES (
          ${target.storeId}, ${target.importId}, 'enrich',
          ${enrichBatchKey(start, end)}, ${providerId}, ${tier}
        )
        ON CONFLICT (import_id, stage, batch_key) DO NOTHING
      `)
      for (const locale of TARGET_LOCALES) {
        await tx.execute(sql`
          INSERT INTO jobs (store_id, import_id, stage, batch_key, provider_id, routing_tier)
          VALUES (
            ${target.storeId}, ${target.importId}, 'translate',
            ${translateBatchKey(start, end, locale)}, ${providerId}, ${tier}
          )
          ON CONFLICT (import_id, stage, batch_key) DO NOTHING
        `)
      }
      start = end + 1
    }
  })
}
