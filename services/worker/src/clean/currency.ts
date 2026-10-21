/**
 * Currency-token detection (EC-040): symbols and ISO codes found in cell
 * text, and the documented default for sheets that carry no currency at all.
 */

export const DEFAULT_CURRENCY = "EUR"

const SYMBOL_TO_CODE: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  $: "USD",
  "＄": "USD",
}

export interface CurrencyScan {
  /** Distinct currencies found, in order of first appearance. */
  currencies: string[]
  /** Cell text with the currency tokens removed — the numeric remainder. */
  rest: string
  /** A bare `$` (or fullwidth) was the evidence — USD/CAD/AUD ambiguous. */
  ambiguousSymbol: boolean
}

/**
 * Find currency evidence in one cell. Currency *words* must stand alone
 * (`EUR` in `Preis EUR`); symbols match anywhere (`1.299,00 €`, `£8`).
 * Distinct multiple currencies in one cell is corruption — the caller flags
 * it; this only reports what it saw.
 */
export function scanCurrency(text: string): CurrencyScan {
  const currencies: string[] = []
  let ambiguousSymbol = false
  let rest = ""

  let lastIndex = 0
  const tokenPattern = /[€£¥$\uFF04]|\b(?:eur|gbp|chf|jpy|usd)\b/gi
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0]
    rest += text.slice(lastIndex, match.index)
    lastIndex = match.index + token.length
    const code = SYMBOL_TO_CODE[token] ?? token.toUpperCase()
    if (token === "$" || token === "\uFF04") ambiguousSymbol = true
    if (!currencies.includes(code)) currencies.push(code)
  }
  rest += text.slice(lastIndex)

  return { currencies, rest, ambiguousSymbol }
}
