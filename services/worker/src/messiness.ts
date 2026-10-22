/**
 * The Messiness Score signal (GLOSSARY): missing fields, identity evidence,
 * variant review state and photo spread. ONE module owns the weights so the
 * enrich handler (TS) and the match-media planner (SQL fragment, generated
 * from the same constants) can never drift.
 *
 * The planner runs BEFORE media matching, so its fragment covers the
 * non-photo terms only; the photo term and the 100 cap apply at enrich
 * time, when photos are matched. The plan-time score only picks the Batch's
 * routing tier, which Demo Mode treats identically.
 */
import { sql, type SQL } from "drizzle-orm"

/** The product fields the score reads — structural, so callers pass their row. */
export interface MessinessProduct {
  identityKind: "code" | "title"
  description: string | null
  category: string | null
  brand: string | null
  gtin: string | null
}

/** Per-term weights, in points. Sync: both sites below consume these. */
export const MESSINESS_WEIGHTS = {
  /** Title-identity products carry weaker identity evidence. */
  titleIdentity: 30,
  missingDescription: 20,
  missingCategory: 15,
  missingBrand: 10,
  missingGtin: 10,
  variantNeedsReview: 15,
  /** Per variant, capped at 4 variants… */
  perVariant: 2,
  variantCap: 4,
  /** Per matched photo, capped at 3 photos (enrich time only). */
  perPhoto: 2,
  photoCap: 3,
} as const

/** The Messiness Score is a 0–100 signal. */
export const MESSINESS_MAX = 100

/**
 * The enrich-time score: the authoritative per-Product value recorded on
 * `product_enrichments.messiness` and used as the routing fallback.
 */
export function messinessScore(
  product: MessinessProduct,
  variantCount: number,
  variantNeedsReview: boolean,
  photoCount: number
): number {
  const w = MESSINESS_WEIGHTS
  let score = 0
  if (product.identityKind === "title") score += w.titleIdentity
  if (!product.description) score += w.missingDescription
  if (!product.category) score += w.missingCategory
  if (!product.brand) score += w.missingBrand
  if (!product.gtin) score += w.missingGtin
  if (variantNeedsReview) score += w.variantNeedsReview
  score += Math.min(variantCount, w.variantCap) * w.perVariant
  score += Math.min(photoCount, w.photoCap) * w.perPhoto
  return Math.min(MESSINESS_MAX, score)
}

/**
 * SQL fragment scoring one product row (aliased `s`, carrying `id`,
 * `identity_kind`, `description`, `category`, `brand`, `gtin`) — the
 * planner-time terms, weights shared with {@link messinessScore}. The photo
 * term and the cap are enrich-time only (see module doc).
 */
export function planTimeMessinessSql(): SQL {
  const w = MESSINESS_WEIGHTS
  return sql`(
        (s.identity_kind = 'title')::int * ${w.titleIdentity}
        + (CASE WHEN COALESCE(s.description, '') = '' THEN ${w.missingDescription} ELSE 0 END)
        + (CASE WHEN COALESCE(s.category, '') = '' THEN ${w.missingCategory} ELSE 0 END)
        + (CASE WHEN COALESCE(s.brand, '') = '' THEN ${w.missingBrand} ELSE 0 END)
        + (CASE WHEN s.gtin IS NULL THEN ${w.missingGtin} ELSE 0 END)
        + (CASE WHEN EXISTS (
             SELECT 1 FROM variants v
             WHERE v.product_id = s.id AND v.needs_review
           ) THEN ${w.variantNeedsReview} ELSE 0 END)
        + LEAST((SELECT count(*) FROM variants v WHERE v.product_id = s.id), ${w.variantCap}) * ${w.perVariant}
      )::int`
}
