/**
 * Deterministic Batch identities (GLOSSARY: Batch, ADR-0002 plan-then-execute).
 *
 * Batch boundaries are computed when a Stage begins and never re-derived, so
 * retries and restarts see identical Batches. The key format is shared
 * between the Worker (which plans and consumes Jobs) and the app (which
 * maps failed rows back to the Jobs that can retry them) — both import the
 * same format/parse helpers so the contract cannot drift.
 */

/** Product-batch key grammar, shared with the app's SQL (regex in Postgres). */
export const PRODUCT_BATCH_KEY_PATTERN =
  "^products-([0-9]{6})-([0-9]{6})(?::([a-z]{2}))?$"

/** The plain product-range pattern (no locale group) for SQL `~` matches. */
export const PRODUCT_BATCH_KEY_PREFIX_PATTERN = "^products-[0-9]{6}-[0-9]{6}"

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
  const match = new RegExp(PRODUCT_BATCH_KEY_PATTERN).exec(key)
  if (!match) return null
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    locale: match[3] ?? null,
  }
}
