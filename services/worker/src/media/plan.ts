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

/** The single deterministic Batch identity of the media barrier. */
export const MEDIA_BATCH_KEY = "media"

/** Products per enrich/translate Batch (production constant). */
export const ENRICH_BATCH_SIZE = 100

export interface PlanMatchMediaOptions {
  /** Tests shrink the constant to exercise multi-Batch Imports quickly. */
  batchSize?: number
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
    // Batches — across re-plans and restarts (ADR-0002).
    const rows = (await tx.execute(sql`
      SELECT natural_key_hash FROM products
      WHERE import_id = ${target.importId}
      ORDER BY natural_key_hash
    `)) as unknown as Array<{ natural_key_hash: string }>
    const count = rows.length

    const insertBatch = (start: number, end: number): Promise<unknown> =>
      tx.execute(sql`
        INSERT INTO jobs (store_id, import_id, stage, batch_key)
        VALUES (
          ${target.storeId}, ${target.importId}, 'enrich',
          ${enrichBatchKey(start, end)}
        )
        ON CONFLICT (import_id, stage, batch_key) DO NOTHING
      `)

    for (let start = 1, ordinal = 0; ordinal < count; ordinal += batchSize) {
      const end = Math.min(start + batchSize - 1, count)
      await insertBatch(start, end)
      for (const locale of TARGET_LOCALES) {
        await tx.execute(sql`
          INSERT INTO jobs (store_id, import_id, stage, batch_key)
          VALUES (
            ${target.storeId}, ${target.importId}, 'translate',
            ${translateBatchKey(start, end, locale)}
          )
          ON CONFLICT (import_id, stage, batch_key) DO NOTHING
        `)
      }
      start = end + 1
    }
  })
}
