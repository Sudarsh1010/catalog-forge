/**
 * Per-cell cleaning: turns one raw cell into a typed {@link CleanedCell}
 * plus EC-cited flags, under the column decisions from the clean plan.
 *
 * Money never touches a float (EC-021): supplier text → digit surgery →
 * integer cents. Ambiguity is flagged, never guessed (EC-038/EC-039/EC-040).
 */
import type {
  CleanedCell,
  CleanedFlag,
  CleanColumnPlan,
  SheetCell,
} from "@workspace/db/schema"

import { DEFAULT_CURRENCY, scanCurrency } from "./currency"
import { isLikelyHtml, sanitizeHtml } from "./html"
import {
  resolveScaled,
  scaledToCents,
  scanNumber,
  type NumberScan,
} from "./number"
import { isBlank, matchKey, repairEncoding, stripInvisible } from "./text"
import {
  CANONICAL_UNIT_BY_FAMILY,
  convertToCanonical,
  splitQuantityCell,
  unitByToken,
} from "./units"

export interface CellCleanResult {
  cell: CleanedCell | null
  flags: CleanedFlag[]
}

/** One cleaned row: positional cells plus the accumulated row flags. */
export interface RowCleanResult {
  values: Array<CleanedCell | null>
  flags: CleanedFlag[]
}

export function flag(
  ec: string | null,
  code: string,
  columnIndex: number,
  message: string
): CleanedFlag {
  return { ec, code, columnIndex, message }
}

/**
 * Clean one raw row into the positional projection + row flags. Cells
 * beyond the header (ragged rows) are preserved as text, unflagged.
 */
export function cleanRow(
  raw: SheetCell[],
  columns: CleanColumnPlan[]
): RowCleanResult {
  const values: Array<CleanedCell | null> = []
  const flags: CleanedFlag[] = []
  const width = Math.max(raw.length, columns.length)
  for (let index = 0; index < width; index++) {
    const plan = columns[index]
    if (!plan) {
      const extra = raw[index]
      values.push(
        extra === null || extra === undefined
          ? null
          : cleanTextPreserving(String(extra))
      )
      continue
    }
    const result = cleanCell(raw[index], plan)
    values.push(result.cell)
    flags.push(...result.flags)
  }
  return { values, flags }
}

/** Text projection for cells without a column plan (ragged overflow). */
function cleanTextPreserving(value: string): CleanedCell {
  return { kind: "text", value, key: value.normalize("NFC").toLowerCase() }
}

/** Clean one raw cell. `raw` may be absent for short (ragged) rows. */
export function cleanCell(
  raw: SheetCell | undefined,
  plan: CleanColumnPlan
): CellCleanResult {
  if (raw === undefined || raw === null) return { cell: null, flags: [] }
  if (typeof raw === "boolean") return cleanText(String(raw), plan)

  const text = typeof raw === "string" ? raw : String(raw)
  if (isBlank(text)) return { cell: null, flags: [] }

  if (plan.kind === "price") return cleanPrice(text, plan)
  if (plan.kind === "quantity") return cleanQuantity(text, plan)
  return cleanText(text, plan)
}

/**
 * Text/html pipeline: encoding repair (EC-002), invisible-character
 * stripping (EC-057), HTML sanitization for markup cells (EC-056),
 * formula-injection neutralization otherwise (EC-022). Display value and
 * NFC match key travel together (EC-053).
 */
function cleanText(text: string, plan: CleanColumnPlan): CellCleanResult {
  const flags: CleanedFlag[] = []
  const encoding = repairEncoding(text)
  if (encoding.repaired) {
    flags.push(
      flag(
        "EC-002",
        "encoding_repaired",
        plan.index,
        `Mojibake repaired (UTF-8 misdecoded as Latin-1) in "${plan.header}".`
      )
    )
  } else if (!encoding.recoverable) {
    flags.push(
      flag(
        "EC-002",
        "encoding_unrecoverable",
        plan.index,
        `Damaged encoding in "${plan.header}" could not be repaired safely — original preserved.`
      )
    )
  }

  const stripped = stripInvisible(encoding.value)
  if (stripped.changed) {
    flags.push(
      flag(
        "EC-057",
        "invisible_chars_stripped",
        plan.index,
        `Invisible/control characters stripped from "${plan.header}".`
      )
    )
  }

  if (isLikelyHtml(stripped.value)) {
    const sanitized = sanitizeHtml(stripped.value)
    if (sanitized.changed) {
      flags.push(
        flag(
          "EC-056",
          "html_sanitized",
          plan.index,
          `Unsafe HTML removed from "${plan.header}" (allowlist: p, br, b, lists, headings).`
        )
      )
    }
    return { cell: { kind: "html", value: sanitized.value }, flags }
  }

  let value = stripped.value
  if (/^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`
    flags.push(
      flag(
        "EC-022",
        "formula_neutralized",
        plan.index,
        `Cell in "${plan.header}" started with a formula character and was neutralized for CSV safety.`
      )
    )
  }
  return { cell: { kind: "text", value, key: matchKey(value) }, flags }
}

/**
 * Price pipeline (EC-021/EC-038/EC-039/EC-040): currency from the cell or
 * column plan, decimal convention from the cell's own separators or the
 * column vote, integer cents by digit arithmetic alone.
 */
function cleanPrice(text: string, plan: CleanColumnPlan): CellCleanResult {
  const flags: CleanedFlag[] = []
  const currency = scanCurrency(text)
  if (currency.currencies.length > 1) {
    flags.push(
      flag(
        "EC-040",
        "price_mixed_currencies_in_cell",
        plan.index,
        `Cell in "${plan.header}" carries several currencies (${currency.currencies.join(", ")}) — not parsed.`
      )
    )
    return { cell: { kind: "unparseable", value: text }, flags }
  }
  const valueCurrency = currency.currencies[0]
  if (currency.ambiguousSymbol) {
    flags.push(
      flag(
        "EC-040",
        "price_currency_symbol_ambiguous",
        plan.index,
        `"${plan.header}": "$" could be USD, CAD or AUD — stored as USD.`
      )
    )
  }
  if (valueCurrency && plan.currency && valueCurrency !== plan.currency) {
    flags.push(
      flag(
        "EC-040",
        "price_currency_mixed",
        plan.index,
        `"${plan.header}" is mostly ${plan.currency} but this cell says ${valueCurrency}.`
      )
    )
  }
  if (!valueCurrency && plan.currencyAssumed) {
    flags.push(
      flag(
        "EC-040",
        "price_currency_assumed",
        plan.index,
        `No currency found for "${plan.header}" — assumed ${DEFAULT_CURRENCY} (store currency).`
      )
    )
  }

  const numeric = scanNumber(currency.rest)
  const scaled = resolveScaled(numeric, plan.decimalLocale)
  if (!scaled) {
    return {
      cell: { kind: "unparseable", value: text },
      flags: [...flags, unparseablePriceFlag(numeric, plan)],
    }
  }
  noteMixedFormat(numeric, plan, flags)

  let rounded = false
  const cents = scaledToCents(scaled, () => {
    rounded = true
  })
  if (rounded) {
    flags.push(
      flag(
        "EC-045",
        "price_rounded",
        plan.index,
        `"${plan.header}" value ${text.trim()} had sub-cent digits rounded away.`
      )
    )
  }
  if (cents === null) {
    flags.push(
      flag(
        "EC-021",
        "price_out_of_range",
        plan.index,
        `"${plan.header}" value ${text.trim()} exceeds the safe integer range for money — not parsed.`
      )
    )
    return { cell: { kind: "unparseable", value: text }, flags }
  }
  if (cents < 0) {
    flags.push(
      flag(
        "EC-043",
        "price_negative",
        plan.index,
        `Negative price ${text.trim()} in "${plan.header}" — data error or credit?`
      )
    )
  }
  return {
    cell: {
      kind: "price",
      cents,
      currency: valueCurrency ?? plan.currency ?? DEFAULT_CURRENCY,
    },
    flags,
  }
}

/** EC-038: an ambiguous value in a column with no decidable vote. */
function unparseablePriceFlag(
  numeric: NumberScan,
  plan: CleanColumnPlan
): CleanedFlag {
  if (numeric.kind === "ambiguous") {
    return flag(
      "EC-038",
      "price_locale_ambiguous",
      plan.index,
      `"${plan.header}" mixes decimal conventions without a majority — value left unparsed rather than guessed.`
    )
  }
  return flag(
    null,
    "price_not_numeric",
    plan.index,
    `"${plan.header}" value is not a parseable price — preserved raw.`
  )
}

/** EC-039: a cell whose proven convention contradicts the column's majority. */
function noteMixedFormat(
  numeric: NumberScan,
  plan: CleanColumnPlan,
  flags: CleanedFlag[]
): void {
  if (
    numeric.kind === "exact" &&
    numeric.locale &&
    plan.decimalLocale &&
    numeric.locale !== plan.decimalLocale
  ) {
    flags.push(
      flag(
        "EC-039",
        "price_format_mixed",
        plan.index,
        `"${plan.header}" mixes decimal formats — this cell follows ${numeric.locale}, the column majority ${plan.decimalLocale}.`
      )
    )
  }
}

/**
 * Quantity pipeline (EC-026/EC-047/EC-048/EC-049): unit from the cell or
 * header hint, canonical metric integer, exact BigInt conversion with one
 * half-up rounding. Ranges, dimension lists and other garbage are flagged.
 */
function cleanQuantity(text: string, plan: CleanColumnPlan): CellCleanResult {
  const flags: CleanedFlag[] = []
  const split = splitQuantityCell(text)
  if (!split) {
    return {
      cell: { kind: "unparseable", value: text },
      flags: [
        flag(
          "EC-048",
          "quantity_unparseable",
          plan.index,
          `"${plan.header}" value "${text.trim()}" is not a single convertible quantity (range, dimension list, or garbage) — preserved raw.`
        ),
      ],
    }
  }

  const numeric = scanNumber(split.numberText)
  const scaled = resolveScaled(numeric, plan.decimalLocale)
  if (!scaled) {
    return {
      cell: { kind: "unparseable", value: text },
      flags: [
        flag(
          numeric.kind === "ambiguous" ? "EC-038" : "EC-048",
          numeric.kind === "ambiguous"
            ? "quantity_locale_ambiguous"
            : "quantity_unparseable",
          plan.index,
          `"${plan.header}" value "${text.trim()}" is not a single convertible quantity (range, dimension list, or garbage) — preserved raw.`
        ),
      ],
    }
  }

  const unit =
    split.unit ?? (plan.defaultUnit ? unitByToken(plan.defaultUnit) : null)
  if (!unit) {
    return {
      cell: { kind: "unparseable", value: text },
      flags: [
        flag(
          "EC-026",
          "quantity_unit_missing",
          plan.index,
          `"${plan.header}" value "${text.trim()}" carries no unit and the header names none — cannot convert, preserved raw.`
        ),
      ],
    }
  }
  if (!split.unit && plan.defaultUnit) {
    // The header supplied the unit — correct per EC-026, but worth a trail.
    flags.push(
      flag(
        "EC-026",
        "quantity_unit_from_header",
        plan.index,
        `Unit ${plan.defaultUnit} taken from the "${plan.header}" header.`
      )
    )
  }

  const canonical = convertToCanonical(scaled, unit)
  if (canonical === null || canonical < 0) {
    return {
      cell: { kind: "unparseable", value: text },
      flags: [
        flag(
          "EC-048",
          canonical !== null ? "quantity_negative" : "quantity_out_of_range",
          plan.index,
          `"${plan.header}" value "${text.trim()}" is outside the convertible range — preserved raw.`
        ),
      ],
    }
  }
  return {
    cell: {
      kind: "quantity",
      value: canonical,
      unit: CANONICAL_UNIT_BY_FAMILY[unit.family],
      original: text.trim(),
    },
    flags,
  }
}
