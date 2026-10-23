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
import {
  TARGET_LOCALES,
  enrichBatchKey,
  translateBatchKey,
} from "@workspace/pipeline"

import type { StagePlanTarget } from "../stages"
import { planTimeMessinessSql } from "../messiness"
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
   * The stamp is claim-gate/Pause metadata ONLY: the model tier for each
   * enrich/translate call is chosen per row at call time, from the
   * enrich-time photo-aware Messiness Score. Omitted (tests of earlier
   * tickets): Jobs stay provider-less and claim regardless of Pauses.
   */
  providerForTier?: (tier: RoutingTier) => string
}

/** Deterministic enrich/translate Batch identities live in @workspace/pipeline
 * (shared with the app's failed-row → Job mapping). */

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
    // Messiness Score is recomputed from the SHARED weights
    // (`src/messiness.ts`, the enrich handler's formula) minus photos —
    // media matching has not run yet, so the score finalizes at enrich
    // time. The plan-time copy only stamps the Job's routing_tier and
    // provider_id — claim-gate/Pause metadata (a Pause holds the Batch
    // under its neediest tier's provider); the per-call model tier is
    // chosen per row at enrich/translate time from the photo-aware score.
    const rows = (await tx.execute(sql`
      WITH scored AS (
        SELECT p.id, p.identity_kind, p.description, p.category, p.brand, p.gtin,
               ROW_NUMBER() OVER (ORDER BY p.natural_key_hash) AS ordinal
        FROM products p
        WHERE p.import_id = ${target.importId}
      )
      SELECT s.ordinal, ${planTimeMessinessSql()} AS messiness
      FROM scored s
      ORDER BY s.ordinal
    `)) as unknown as Array<{ ordinal: number; messiness: number }>
    const count = rows.length

    for (let start = 1, ordinal = 0; ordinal < count; ordinal += batchSize) {
      const end = Math.min(start + batchSize - 1, count)
      // The Batch's stamp: its neediest product's tier — what the Pause
      // claim gate holds the whole Batch under. It never picks a model:
      // each call's tier comes from its own row's enrich-time score.
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
