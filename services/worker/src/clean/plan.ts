/**
 * The clean Stage's planner (ADR-0002 plan-then-execute).
 *
 * When an Import enters `clean`, ALL row-Batch Jobs are inserted up front
 * with deterministic boundaries (row-index Batches of a fixed constant size),
 * and the per-column decisions the Batch Jobs will execute against are
 * computed once by a deterministic scan of the raw rows: decimal-locale
 * majority vote (EC-038), currency votes from symbols and header hints
 * (EC-040), and header unit hints (EC-026). Batch Jobs are independent and
 * may run concurrently or out of order — they never re-derive these votes.
 *
 * Re-planning is safe and idempotent: boundaries depend only on the row
 * index range, the vote only on row order, and Job inserts are
 * conflict-nothing on the (import, stage, batch) identity.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { CleanColumnPlan } from "@workspace/db/schema"

import { scanCurrency, type CurrencyScan } from "./currency"
import { scanNumber, type DecimalLocale } from "./number"
import { looksLikeQuantity, unitFromHeader, type UnitFamily } from "./units"

/** Fixed constant Batch size: one Job per 500-row slice (production). */
export const CLEAN_CHUNK_SIZE = 500

export interface CleanStageTarget {
  importId: string
  storeId: string
}

export interface PlanCleanOptions {
  /** Tests shrink the constant to exercise multi-Batch Imports quickly. */
  chunkSize?: number
}

const SCAN_PAGE_SIZE = 5_000

// Header hint dictionaries (EC-025/EC-026): what makes a column a price or
// quantity column before any cell is inspected.
const PRICE_HEADER =
  /(price|preis|prix|uvp|rrp|netto|brutto|pve|amount|cost|€|£|\$|eur\b|gbp\b|usd\b|chf\b)/i
const FAMILY_HEADER: Array<[UnitFamily, RegExp]> = [
  [
    "length",
    /(länge|laenge|length|breite|width|höhe|hoehe|height|tiefe|depth|durchmesser|diameter|ø|longueur|largeur|hauteur|profondeur)/i,
  ],
  ["weight", /(gewicht|weight|poids|masse|\blbs?\b|\bkg\b)/i],
  ["volume", /(volumen|volume|litre|liter|\bml\b|\bcl\b|fl\s?oz)/i],
]

interface ColumnScan {
  header: string
  /** Non-blank cells seen. */
  valueCount: number
  currencyCounts: Map<string, number>
  localeVotes: { de: number; en: number }
  quantityShaped: number
  headerPrice: boolean
  headerFamily: UnitFamily | null
}

/** Decide one column's plan from its accumulated scan (deterministic). */
export async function planCleanStage(
  db: Database,
  target: CleanStageTarget,
  options?: PlanCleanOptions
): Promise<void> {
  const chunkSize = options?.chunkSize ?? CLEAN_CHUNK_SIZE
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`clean plan: invalid Batch size ${chunkSize}`)
  }

  const headerRows = (await db.execute(sql`
    SELECT sheet_header FROM imports WHERE id = ${target.importId}
  `)) as unknown as Array<{ sheet_header: string[] | null }>
  const header = headerRows[0]?.sheet_header
  if (!header) {
    // Intake guarantees the header before the stage can advance; a missing
    // header is a contract violation worth retrying loudly.
    throw new Error(`clean plan: import ${target.importId} has no sheet header`)
  }

  const scans: ColumnScan[] = header.map((name) => newColumnScan(name))
  await scanAllRows(db, target.importId, (raw) => {
    for (let index = 0; index < scans.length; index++) {
      const cell = raw[index]
      if (cell !== null && cell !== undefined) scanCell(scans[index]!, cell)
    }
  })

  const columns: CleanColumnPlan[] = scans.map((scan, index) => ({
    ...decideColumn(scan),
    index,
  }))

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO clean_plans (import_id, store_id, columns)
      VALUES (${target.importId}, ${target.storeId}, ${JSON.stringify(columns)}::jsonb)
      ON CONFLICT (import_id) DO UPDATE SET
        store_id = EXCLUDED.store_id,
        columns = EXCLUDED.columns,
        updated_at = now()
    `)

    const bounds = (await tx.execute(sql`
      SELECT COALESCE(MIN(row_index), 0) AS min_index, COALESCE(MAX(row_index), 0) AS max_index
      FROM sheet_rows WHERE import_id = ${target.importId}
    `)) as unknown as Array<{ min_index: number; max_index: number }>
    const { min_index: minIndex, max_index: maxIndex } = bounds[0] ?? {
      min_index: 0,
      max_index: 0,
    }
    if (minIndex === 0 && maxIndex === 0) return // zero rows: nothing to clean

    for (let start = minIndex; start <= maxIndex; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, maxIndex)
      await tx.execute(sql`
        INSERT INTO jobs (store_id, import_id, stage, batch_key)
        VALUES (
          ${target.storeId}, ${target.importId}, 'clean',
          ${batchKey(start, end)}
        )
        ON CONFLICT (import_id, stage, batch_key) DO NOTHING
      `)
    }
  })
}

/** Deterministic batch identity: 1-based inclusive row-index range. */
export function batchKey(start: number, end: number): string {
  return `rows-${String(start).padStart(6, "0")}-${String(end).padStart(6, "0")}`
}

/** Parse a batch key back to its inclusive [start, end] row-index range. */
export function parseBatchKey(
  key: string
): { start: number; end: number } | null {
  const match = /^rows-(\d+)-(\d+)$/.exec(key)
  if (!match) return null
  return { start: Number(match[1]), end: Number(match[2]) }
}

/** Page through the immutable raw rows in row order (bounded memory). */
async function scanAllRows(
  db: Database,
  importId: string,
  visit: (raw: Array<string | number | boolean | null>) => Promise<void> | void
): Promise<void> {
  let cursor = 0
  for (;;) {
    const rows = (await db.execute(sql`
      SELECT row_index, raw FROM sheet_rows
      WHERE import_id = ${importId} AND row_index > ${cursor}
      ORDER BY row_index LIMIT ${SCAN_PAGE_SIZE}
    `)) as unknown as Array<{
      row_index: number
      raw: Array<string | number | boolean | null>
    }>
    if (rows.length === 0) return
    for (const row of rows) {
      await visit(row.raw)
      cursor = row.row_index
    }
    if (rows.length < SCAN_PAGE_SIZE) return
  }
}

function newColumnScan(header: string): ColumnScan {
  return {
    header,
    valueCount: 0,
    currencyCounts: new Map(),
    localeVotes: { de: 0, en: 0 },
    quantityShaped: 0,
    headerPrice: PRICE_HEADER.test(header),
    headerFamily:
      FAMILY_HEADER.find(([, pattern]) => pattern.test(header))?.[0] ?? null,
  }
}

function scanCell(scan: ColumnScan, cell: string | number | boolean): void {
  scan.valueCount++
  const text = typeof cell === "string" ? cell : String(cell)

  const currency: CurrencyScan = scanCurrency(text)
  for (const code of currency.currencies) {
    scan.currencyCounts.set(code, (scan.currencyCounts.get(code) ?? 0) + 1)
  }

  // The number part votes on the column's decimal convention whether or
  // not a currency token shared the cell (`1.299,00 €` proves de).
  const numeric = scanNumber(currency.rest)
  if (numeric.kind === "exact" && numeric.locale) {
    scan.localeVotes[numeric.locale]++
  }
  if (currency.currencies.length === 0 && looksLikeQuantity(text)) {
    scan.quantityShaped++
  }
}

/** Decide one column's plan from its accumulated scan (deterministic). */
function decideColumn(scan: ColumnScan): CleanColumnPlan {
  const currency = voteCurrency(scan)
  const isPrice = scan.currencyCounts.size > 0 || scan.headerPrice
  if (isPrice) {
    return {
      index: -1,
      header: scan.header,
      kind: "price",
      decimalLocale: voteLocale(scan),
      currency: currency.code,
      currencyAssumed: currency.assumed,
    }
  }
  const quantity = scan.headerFamily !== null || scan.quantityShaped > 0
  if (quantity) {
    return {
      index: -1,
      header: scan.header,
      kind: "quantity",
      decimalLocale: voteLocale(scan),
      currency: null,
      currencyAssumed: false,
      defaultUnit: unitFromHeader(scan.header)?.unit.token ?? null,
    }
  }
  return {
    index: -1,
    header: scan.header,
    kind: "text",
    decimalLocale: null,
    currency: null,
    currencyAssumed: false,
  }
}

/** Majority vote of self-proving cells; a tie or no signal decides nothing (EC-038). */
function voteLocale(scan: ColumnScan): DecimalLocale | null {
  if (scan.localeVotes.de > scan.localeVotes.en) return "de"
  if (scan.localeVotes.en > scan.localeVotes.de) return "en"
  return null
}

/**
 * Column currency: observed symbols win by majority; a tie decides nothing.
 * Without symbols, the header hint applies; with neither, cells fall back to
 * the documented default with an explicit assumption flag (EC-040).
 */
function voteCurrency(scan: ColumnScan): {
  code: string | null
  assumed: boolean
} {
  let best: string | null = null
  let bestCount = 0
  let tie = false
  for (const [code, count] of scan.currencyCounts) {
    if (count > bestCount) {
      best = code
      bestCount = count
      tie = false
    } else if (count === bestCount && code !== best) {
      tie = true
    }
  }
  if (best !== null && !tie) return { code: best, assumed: false }
  const headerCurrency = scanCurrency(scan.header).currencies[0]
  if (headerCurrency && scan.currencyCounts.size === 0) {
    return { code: headerCurrency, assumed: false }
  }
  return { code: null, assumed: true }
}
