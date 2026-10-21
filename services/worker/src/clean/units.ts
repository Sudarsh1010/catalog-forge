/**
 * Unit families and canonical-metric conversion (EC-047/EC-048/EC-049).
 *
 * Canonical storage: length in mm, mass in g, volume in ml — integers.
 * Conversion factors are exact decimals expressed as BigInt rationals, so
 * nothing ever passes through a float; one half-up rounding happens at the
 * very end (`19.6"` → 497.84 mm → 498 mm).
 */

import { roundScaledDivide } from "./number"

export type CanonicalUnit = "mm" | "g" | "ml"

export type UnitFamily = "length" | "weight" | "volume"

export const CANONICAL_UNIT_BY_FAMILY: Record<UnitFamily, CanonicalUnit> = {
  length: "mm",
  weight: "g",
  volume: "ml",
}

interface UnitDef {
  family: UnitFamily
  /** Exact value of one unit in canonical units: factorN / factorD. */
  factorN: bigint
  factorD: bigint
  /** The lowercase match token (incl. abbreviation spellings). */
  token: string
}

const inch: UnitDef = {
  family: "length",
  factorN: 254n,
  factorD: 10n,
  token: "in",
}
const foot: UnitDef = {
  family: "length",
  factorN: 3048n,
  factorD: 10n,
  token: "ft",
}
const pound: UnitDef = {
  family: "weight",
  factorN: 45359237n,
  factorD: 100000n,
  token: "lb",
}
const ounce: UnitDef = {
  family: "weight",
  factorN: 283495n,
  factorD: 10000n,
  token: "oz",
}
const flOz: UnitDef = {
  family: "volume",
  factorN: 2957353n,
  factorD: 100000n,
  token: "fl oz",
}

/** Longest-first so `fl oz` wins over `oz` and `mm` over `m`. */
const CELL_UNITS: UnitDef[] = [
  { family: "length", factorN: 1n, factorD: 1n, token: "mm" },
  { family: "length", factorN: 10n, factorD: 1n, token: "cm" },
  { family: "length", factorN: 1000n, factorD: 1n, token: "m" },
  inch,
  { ...inch, token: "inches" },
  { ...inch, token: "inch" },
  { ...inch, token: "zoll" }, // DE for inches (EC-049)
  { ...inch, token: '"' },
  { ...inch, token: "”" },
  foot,
  { ...foot, token: "feet" },
  { ...foot, token: "foot" },
  { ...foot, token: "'" },
  { family: "weight", factorN: 1n, factorD: 1000n, token: "mg" },
  { family: "weight", factorN: 1n, factorD: 1n, token: "g" },
  { family: "weight", factorN: 1000n, factorD: 1n, token: "kg" },
  { ...pound, token: "lbs" },
  pound,
  { ...pound, token: "pounds" },
  { ...pound, token: "pound" },
  ounce,
  { ...ounce, token: "ounces" },
  { ...ounce, token: "ounce" },
  { family: "volume", factorN: 1n, factorD: 1n, token: "ml" },
  { family: "volume", factorN: 10n, factorD: 1n, token: "cl" },
  { family: "volume", factorN: 1000n, factorD: 1n, token: "l" },
  { ...flOz, token: "fl. oz" },
  flOz,
]

const CELL_UNITS_BY_LENGTH = [...CELL_UNITS].sort(
  (a, b) => b.token.length - a.token.length
)

/**
 * Split one quantity cell into its numeric part and its unit. Tolerates the
 * noise of EC-048: `ca. 50 cm`, `Ø 50 cm`, `50 cm (H)`. Returns `null` for
 * anything not shaped `number [unit]` — ranges (`50-60 cm`), dimension
 * lists (`50 x 30 x 20`) and garbage all land there and get flagged.
 */
export function splitQuantityCell(
  text: string
): { numberText: string; unit: UnitDef | null } | null {
  let rest = text.trim()
  // Approximation markers and diameter prefixes carry no convertible meaning.
  rest = rest
    .replace(/^(?:ca\.?|circa|approx\.?|about|≈|~|Ø|∅)\s*/i, "")
    .replace(/\s*(?:\((?:h|w|l|d|t|b)\)\s*)$/i, "")
    .trim()

  for (const unit of CELL_UNITS_BY_LENGTH) {
    if (!rest.toLowerCase().endsWith(unit.token)) continue
    const numberText = rest.slice(0, -unit.token.length).trim()
    if (numberText === "" || !/[0-9]$/.test(numberText)) continue
    return { numberText, unit }
  }
  // No unit token: the whole remainder must be a bare number for the cell
  // to be quantity-shaped (the header may supply the unit later). Anything
  // with letters ("SKU-1") is not a quantity.
  if (/^[0-9.,+\u2212][0-9.,+\u2212\s]*$/.test(rest)) {
    return { numberText: rest, unit: null }
  }
  return null
}

/** Find a unit token standing alone in a header ("Länge (cm)", "Weight kg"). */
export function unitFromHeader(
  header: string
): { family: UnitFamily; unit: UnitDef } | null {
  const lowered = header.toLowerCase()
  for (const unit of CELL_UNITS_BY_LENGTH) {
    if (unit.token.length < 2) continue // bare g/m/l/' too collision-prone in headers
    const pattern = new RegExp(
      `(^|[^a-z0-9])${unit.token.replace(".", "\\.")}([^a-z0-9]|$)`,
      "i"
    )
    if (pattern.test(lowered)) return { family: unit.family, unit }
  }
  // Single-letter units only when the header parenthesizes them — the
  // common "Länge (m)" / "Gewicht (g)" form; bare "m"/"g" in prose is too
  // collision-prone to infer from.
  const parenthesized = header.match(/\((mm|cm|m|g|kg|ml|cl|l)\)/i)
  if (parenthesized) {
    const token = parenthesized[1]!.toLowerCase()
    const unit = CELL_UNITS.find((u) => u.token === token)
    if (unit) return { family: unit.family, unit }
  }
  return null
}

/** Detect a unit token in free text (used for column classification). */
export function looksLikeQuantity(text: string): boolean {
  return splitQuantityCell(text) !== null
}

/** Look a unit token back up (column plans store the header's token). */
export function unitByToken(token: string): UnitDef | null {
  return CELL_UNITS.find((unit) => unit.token === token) ?? null
}

export type { UnitDef }

/**
 * Convert a scaled-integer value from its unit to the family's canonical
 * unit, with exactly one half-up rounding (EC-047: no false precision).
 * Value = digits / 10^fractionCount, so conversion is
 * `digits × factorN / (10^fractionCount × factorD)` in exact BigInt math.
 */
export function convertToCanonical(
  scaled: { negative: boolean; digits: string; fractionCount: number },
  unit: UnitDef
): number | null {
  const magnitude = BigInt(scaled.digits === "" ? "0" : scaled.digits)
  const signed = scaled.negative ? -magnitude : magnitude
  const converted = roundScaledDivide(
    signed * unit.factorN,
    unit.factorD * 10n ** BigInt(scaled.fractionCount)
  )
  if (converted > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(converted)
}
