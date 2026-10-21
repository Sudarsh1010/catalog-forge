/**
 * Decimal-number classification and conversion — the EC-038/EC-039/EC-021
 * core. All input is supplier text; all output is strings and integers.
 * Floats never appear: values are parsed as scaled BigInts, prices end as
 * integer cents (EC-021: parse to string, never through a double).
 *
 * Two decimal conventions matter (EC-038):
 *   de: `1.299,00`  → dot groups, comma decimal
 *   en: `1,299.00`  → comma groups, dot decimal
 */

export type DecimalLocale = "de" | "en"

export type NumberKind =
  | /** Pure digits, no separators — locale-irrelevant. */ "integer"
  | /** Separators prove one convention (e.g. `12,5`, `1.299,00`). */ "exact"
  | /** A single 3-digit group (`1.299`, `1,234`) — both readings valid. */ "ambiguous"
  | /** Not a parseable decimal at all. */ "invalid"

export interface NumberScan {
  kind: NumberKind
  /** Convention the text itself proves (`exact` only). */
  locale: DecimalLocale | null
  negative: boolean
  /** Integer-part digits with grouping removed (no sign). */
  integerDigits: string
  /** Fraction digits as written (no separator). */
  fractionDigits: string
}

const INVALID_SCAN: NumberScan = {
  kind: "invalid",
  locale: null,
  negative: false,
  integerDigits: "",
  fractionDigits: "",
}

/** Normalize supplier noise: NBSP/typographic spaces, unicode minus, trim. */
export function normalizeNumericText(input: string): string {
  return input
    .replaceAll(/[\s\u00a0\u202f\u2009\u2007]/g, "")
    .replaceAll(/\u2212/g, "-")
    .trim()
}

/**
 * Classify one numeric token. The ambiguity rule from EC-038: a single
 * separator followed by exactly three digits (`1.299`, `1,234`) is genuinely
 * both a de grouping and an en decimal — it never self-decides; the column
 * vote must. Everything with a provable convention decides itself.
 */
export function scanNumber(raw: string): NumberScan {
  const text = normalizeNumericText(raw)
  const negative = text.startsWith("-")
  const body = negative ? text.slice(1) : text.replace(/^\+/, "")
  if (body === "" || !/^\d*$/.test(body.split(/[.,]/).join(""))) {
    return INVALID_SCAN
  }

  const dots = body.split(".").length - 1
  const commas = body.split(",").length - 1

  if (dots === 0 && commas === 0) {
    return {
      kind: "integer",
      locale: null,
      negative,
      integerDigits: body,
      fractionDigits: "",
    }
  }

  if (dots > 0 && commas > 0) {
    // Both separators: the rightmost one is the decimal separator — proven.
    const decimal = body.lastIndexOf(",") > body.lastIndexOf(".") ? "," : "."
    const grouping = decimal === "," ? "." : ","
    return splitProven(body, decimal, grouping, negative)
  }

  const sep = dots > 0 ? "." : ","
  const parts = body.split(sep)
  if (parts.length === 2) {
    // One separator occurrence: `[int][sep][frac]`.
    const [intPart, fracPart = ""] = parts
    if (fracPart.length === 3) {
      // `1.299` / `1,234` — de grouping or en decimal (EC-038).
      return {
        kind: "ambiguous",
        locale: null,
        negative,
        integerDigits: intPart!,
        fractionDigits: fracPart,
      }
    }
    return {
      kind: "exact",
      locale: sep === "," ? "de" : "en",
      negative,
      integerDigits: intPart!,
      fractionDigits: fracPart,
    }
  }
  // Multiple separators of one kind: pure grouping (`1.234.567`, `1,234,567`).
  // en never groups with dots, de never groups with commas — proven.
  if (parts[0]!.length === 0 || !parts.slice(1).every((g) => g.length === 3)) {
    return INVALID_SCAN
  }
  return {
    kind: "exact",
    locale: sep === "," ? "en" : "de",
    negative,
    integerDigits: parts.join(""),
    fractionDigits: "",
  }
}

function splitProven(
  body: string,
  decimal: "." | ",",
  grouping: "." | ",",
  negative: boolean
): NumberScan {
  const decimalIndex = body.lastIndexOf(decimal)
  const intSide = body.slice(0, decimalIndex).split(grouping).join("")
  const fracSide = body.slice(decimalIndex + 1)
  if (intSide === "" || !/^\d+$/.test(intSide) || !/^\d+$/.test(fracSide)) {
    return INVALID_SCAN
  }
  return {
    kind: "exact",
    locale: decimal === "," ? "de" : "en",
    negative,
    integerDigits: intSide,
    fractionDigits: fracSide,
  }
}

export interface ScaledInteger {
  negative: boolean
  /** All digits (integer part + fraction part) as one string. */
  digits: string
  /** How many trailing digits of `digits` are fraction digits. */
  fractionCount: number
}

/**
 * Resolve a scan against the column's voted locale. Ambiguous scans need the
 * vote; with no decidable vote they stay unresolved (EC-038: flag, never
 * guess). Pure integers are locale-irrelevant and always resolve.
 */
export function resolveScaled(
  scan: NumberScan,
  columnLocale: DecimalLocale | null
): ScaledInteger | null {
  if (scan.kind === "invalid") return null
  if (scan.kind === "ambiguous" && columnLocale === null) return null
  const isDecimal =
    scan.kind === "exact"
      ? scan.fractionDigits.length > 0
      : scan.kind === "ambiguous" && columnLocale === "en"
  return {
    negative: scan.negative,
    digits: scan.integerDigits + scan.fractionDigits,
    fractionCount: isDecimal ? scan.fractionDigits.length : 0,
  }
}

/**
 * Convert a scaled integer to integer cents, half-up rounding on the dropped
 * tail — pure digit surgery, no floats. Returns `null` beyond the safe
 * integer range for money (caller flags rather than truncating silently).
 * `onRounded` fires when nonzero digits were actually dropped (EC-045).
 */
export function scaledToCents(
  scaled: ScaledInteger,
  onRounded?: (droppedDigits: string) => void
): number | null {
  const intDigits = Math.max(0, scaled.digits.length - scaled.fractionCount)
  // `.5` arrives as digits "5" with fractionCount 1: the integer part is 0.
  const intPart = scaled.digits.slice(0, intDigits).padStart(1, "0")
  const fraction = scaled.digits.slice(intDigits)
  const head = intPart + fraction.padEnd(2, "0").slice(0, 2)
  if (head.length > 15) return null
  const tail = fraction.length > 2 ? fraction.slice(2) : ""
  let cents = Number(head)
  if (tail !== "" && tail[0]! >= "5") cents += 1
  if (tail !== "" && /[1-9]/.test(tail) && onRounded) onRounded(tail)
  return scaled.negative ? -cents : cents
}

/** Round-half-up scaled-integer division via BigInt — exact, no floats. */
export function roundScaledDivide(
  numerator: bigint,
  denominator: bigint
): bigint {
  const doubled = numerator * 2n
  const quotient = doubled / denominator
  const remainder = doubled - quotient * denominator
  return remainder * 2n >= denominator ? quotient + 1n : quotient
}
