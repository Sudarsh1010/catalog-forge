/**
 * Ranked photo→Product matching (EC-072). Strategies, in order:
 *
 *   1. exact SKU/GTIN token in the file's base name,
 *   2. normalized-title match of the base name against the Product title,
 *   3. SKU/GTIN token in a subfolder segment of the entry path.
 *
 * A photo gets exactly one best match — the highest-ranking strategy wins,
 * ties break deterministically on (natural key, variant key). Filenames are
 * heuristics, so every unmatched photo becomes a Parked Photo with a reason
 * instead of a guess.
 */
import { identityKey } from "../group/keys"

export interface MatchableVariant {
  variantId: string
  variantKey: string
  /** Display SKU; matching runs on its identity key. */
  sku: string | null
  gtin: string | null
  /** Variant-axis values by header, display form; insertion order is the
   * sheet's header order and doubles as the deterministic refinement order. */
  attributes: Record<string, string>
}

export interface MatchableProduct {
  productId: string
  naturalKey: string
  /** identityKey of the Product title. */
  titleKey: string
  gtin: string | null
  variants: MatchableVariant[]
}

export interface PhotoMatch {
  productId: string
  variantId: string | null
  via: "sku" | "gtin" | "title" | "subfolder"
  /** The token that decided the match, display form (dashboard). */
  token: string
}

const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i

/** Split an entry path into directory segments and extension-less base name. */
export function splitPhotoPath(path: string): {
  dirs: string[]
  base: string
} {
  const normalized = path.replaceAll("\\", "/")
  const cut = normalized.lastIndexOf("/")
  const dirs =
    cut === -1 ? [] : normalized.slice(0, cut).split("/").filter(Boolean)
  const rawBase = cut === -1 ? normalized : normalized.slice(cut + 1)
  const base = rawBase.replace(PHOTO_EXTENSIONS, "")
  return { dirs, base }
}

/** Word tokens of a name fragment (identity-folded, letters/numbers kept). */
function tokensOf(fragment: string): string[] {
  return identityKey(fragment)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * The contiguous token window equal to the code's parts (separator-joined or
 * squashed), or `null`. `TP-100-R` matches `tp_100_r_01` via [tp,100,r].
 */
function codeWindow(tokens: string[], parts: string[]): string | null {
  if (parts.length === 0) return null
  for (let start = 0; start + parts.length <= tokens.length; start++) {
    const window = tokens.slice(start, start + parts.length)
    if (
      window.join("-") === parts.join("-") ||
      window.join("") === parts.join("")
    )
      return window.join("-")
  }
  return null
}

/** GTIN compare ignores leading zeros (UPC-A 12 vs GTIN-14, EC-036). */
function gtinValue(digits: string): string {
  return digits.replace(/^0+/, "") || "0"
}

function gtinWindow(tokens: string[], gtin: string): string | null {
  const wanted = gtinValue(gtin)
  for (let start = 0; start < tokens.length; start++) {
    for (let end = start + 1; end <= tokens.length; end++) {
      const joined = tokens.slice(start, end).join("")
      if (!/^\d+$/.test(joined)) continue
      if (gtinValue(joined) === wanted) return tokens.slice(start, end).join("")
    }
  }
  return null
}

interface Candidate {
  product: MatchableProduct
  variant: MatchableVariant | null
  via: PhotoMatch["via"]
  token: string
}

/** Deterministic winner among one strategy's candidates. */
function pick(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => {
    if (a.product.naturalKey !== b.product.naturalKey)
      return a.product.naturalKey < b.product.naturalKey ? -1 : 1
    const aKey = a.variant?.variantKey ?? ""
    const bKey = b.variant?.variantKey ?? ""
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })[0]!
}

/**
 * Match one photo (entry path) against the Import's Products by the ranked
 * strategies. Returns the best match or `null` — the caller parks the photo.
 */
export function matchPhoto(
  entryPath: string,
  products: MatchableProduct[]
): PhotoMatch | null {
  const { dirs, base } = splitPhotoPath(entryPath)
  const baseTokens = tokensOf(base)

  // Strategy 1: exact SKU/GTIN token in the base name.
  const skuCandidates: Candidate[] = []
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.sku === null) continue
      const token = codeWindow(baseTokens, tokensOf(variant.sku))
      if (token !== null)
        skuCandidates.push({ product, variant, via: "sku", token })
    }
  }
  const skuWinner = pick(skuCandidates)
  if (skuWinner) return toMatch(skuWinner)

  // Strategy 2a: GTIN token in the base name.
  const gtinCandidates: Candidate[] = []
  for (const product of products) {
    if (product.gtin !== null) {
      const token = gtinWindow(baseTokens, product.gtin)
      if (token !== null)
        gtinCandidates.push({ product, variant: null, via: "gtin", token })
    }
    for (const variant of product.variants) {
      if (variant.gtin === null) continue
      const token = gtinWindow(baseTokens, variant.gtin)
      if (token !== null)
        gtinCandidates.push({ product, variant, via: "gtin", token })
    }
  }
  const gtinWinner = pick(gtinCandidates)
  if (gtinWinner) return toMatch(gtinWinner)

  // Strategy 2b: normalized-title match; a variant attribute token in the
  // name (colour words like `rot`) pins the Variant.
  const titleCandidates: Candidate[] = []
  const baseKey = identityKey(base)
  for (const product of products) {
    if (product.titleKey === "" || baseKey !== product.titleKey) continue
    let refined: Candidate = {
      product,
      variant: null,
      via: "title",
      token: baseKey,
    }
    for (const variant of product.variants) {
      const attribute = Object.entries(variant.attributes).find(([, value]) => {
        const key = identityKey(value)
        return key.length > 0 && tokensOf(base).includes(key)
      })
      if (attribute) {
        refined = {
          product,
          variant,
          via: "title",
          token: `${baseKey} (${attribute[0]}=${attribute[1]})`,
        }
        break
      }
    }
    titleCandidates.push(refined)
  }
  const titleWinner = pick(titleCandidates)
  if (titleWinner) return toMatch(titleWinner)

  // Strategy 3: SKU/GTIN token in a subfolder segment of the entry path.
  const folderCandidates: Candidate[] = []
  for (const dir of dirs) {
    const dirTokens = tokensOf(dir)
    for (const product of products) {
      for (const variant of product.variants) {
        if (variant.sku !== null) {
          const token = codeWindow(dirTokens, tokensOf(variant.sku))
          if (token !== null)
            folderCandidates.push({ product, variant, via: "subfolder", token })
        }
        if (variant.gtin !== null) {
          const token = gtinWindow(dirTokens, variant.gtin)
          if (token !== null)
            folderCandidates.push({ product, variant, via: "subfolder", token })
        }
      }
    }
  }
  const folderWinner = pick(folderCandidates)
  return folderWinner ? toMatch(folderWinner) : null
}

function toMatch(candidate: Candidate): PhotoMatch {
  return {
    productId: candidate.product.productId,
    variantId: candidate.variant?.variantId ?? null,
    via: candidate.via,
    token: candidate.token,
  }
}
