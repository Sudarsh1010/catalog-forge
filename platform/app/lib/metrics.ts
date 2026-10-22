/**
 * Metrics read models (ticket #19): every block is a plain SELECT over one
 * Postgres view from `core/db/drizzle/0013_metrics_views.sql` — no rollup
 * tables, no re-derivation from base tables. The Row Ledger stays the only
 * source of processing rates; provider_usage stays the only source of cost.
 */
import type { Database } from "@workspace/db"
import { sql } from "drizzle-orm"

import type {
  MetricsCoverageRowDto,
  MetricsCostDayDto,
  MetricsModelUsageRowDto,
  MetricsOverviewDto,
  MetricsRatesDto,
  MetricsSavingsRowDto,
  MetricsSpeedRowDto,
} from "@workspace/contracts"

interface ImportRatesRow {
  total_rows: number | string
  done_rows: number | string
  needs_review_rows: number | string
  failed_rows: number | string
}

interface ModelUsageRow {
  provider_id: string
  model: string
  operation: string
  calls: number | string
  tokens_in: number | string
  tokens_out: number | string
  cost_micros: number | string
}

interface CostDayRow {
  day: string | Date
  calls: number | string
  cost_micros: number | string
}

interface SpeedRow {
  provider_id: string
  model: string
  operation: string
  calls: number | string
  avg_duration_ms: string | null
  slowest_duration_ms: number | string | null
}

interface CoverageRow {
  locale: string
  products_enriched: number | string
  products_translated: number | string
  fields_translated: number | string
  coverage_pct: string | null
  out_of_date: number | string
}

interface SavingsRow {
  operation: string
  provider_id: string
  model: string
  calls: number | string
  actual_cost_micros: number | string
  strong_cost_micros: number | string
  saved_micros: number | string
}

const num = (value: number | string): number => Number(value)

/** The Metrics-tab payload, one view per block. */
export async function loadMetricsOverview(
  db: Database
): Promise<MetricsOverviewDto> {
  const ratesRows = (await db.execute(sql`
    SELECT COALESCE(SUM(total_rows), 0) AS total_rows,
           COALESCE(SUM(done_rows), 0) AS done_rows,
           COALESCE(SUM(needs_review_rows), 0) AS needs_review_rows,
           COALESCE(SUM(failed_rows), 0) AS failed_rows
    FROM metrics_import_rates
  `)) as unknown as ImportRatesRow[]

  const usageRows = (await db.execute(sql`
    SELECT provider_id, model, operation, calls,
           tokens_in, tokens_out, cost_micros
    FROM metrics_model_usage
    ORDER BY cost_micros DESC, model, provider_id, operation
  `)) as unknown as ModelUsageRow[]

  const costRows = (await db.execute(sql`
    SELECT day, calls, cost_micros
    FROM metrics_cost_daily
    ORDER BY day
  `)) as unknown as CostDayRow[]

  const speedRows = (await db.execute(sql`
    SELECT provider_id, model, operation, calls,
           avg_duration_ms, slowest_duration_ms
    FROM metrics_model_speed
    ORDER BY avg_duration_ms DESC, model, provider_id, operation
  `)) as unknown as SpeedRow[]

  const coverageRows = (await db.execute(sql`
    SELECT locale, products_enriched, products_translated,
           fields_translated, coverage_pct, out_of_date
    FROM metrics_translation_coverage
    ORDER BY locale
  `)) as unknown as CoverageRow[]

  const savingsRows = (await db.execute(sql`
    SELECT operation, provider_id, model, calls,
           actual_cost_micros, strong_cost_micros, saved_micros
    FROM metrics_routing_savings
    ORDER BY saved_micros DESC, model, provider_id, operation
  `)) as unknown as SavingsRow[]

  // Rates aggregate across imports; the percentages recompute over the
  // summed ledger states so they stay an exact partition of totalRows.
  const totalRows = num(ratesRows[0]?.total_rows ?? 0)
  const doneRows = num(ratesRows[0]?.done_rows ?? 0)
  const needsReviewRows = num(ratesRows[0]?.needs_review_rows ?? 0)
  const failedRows = num(ratesRows[0]?.failed_rows ?? 0)
  const pct = (part: number): number =>
    totalRows === 0 ? 0 : Math.round(((100 * part) / totalRows) * 100) / 100

  const rates: MetricsRatesDto = {
    totalRows,
    doneRows,
    needsReviewRows,
    failedRows,
    donePct: pct(doneRows),
    needsReviewPct: pct(needsReviewRows),
    failedPct: pct(failedRows),
  }

  const modelUsage: MetricsModelUsageRowDto[] = usageRows.map((row) => ({
    providerId: row.provider_id,
    model: row.model,
    operation: row.operation,
    calls: num(row.calls),
    tokensIn: num(row.tokens_in),
    tokensOut: num(row.tokens_out),
    costMicros: num(row.cost_micros),
  }))

  const costOverTime: MetricsCostDayDto[] = costRows.map((row) => ({
    day:
      row.day instanceof Date
        ? row.day.toISOString().slice(0, 10)
        : String(row.day).slice(0, 10),
    calls: num(row.calls),
    costMicros: num(row.cost_micros),
  }))

  const speed: MetricsSpeedRowDto[] = speedRows.map((row) => ({
    providerId: row.provider_id,
    model: row.model,
    operation: row.operation,
    calls: num(row.calls),
    avgDurationMs:
      row.avg_duration_ms === null ? null : num(row.avg_duration_ms),
    slowestDurationMs:
      row.slowest_duration_ms === null ? null : num(row.slowest_duration_ms),
  }))

  const translationCoverage: MetricsCoverageRowDto[] = coverageRows.map(
    (row) => ({
      locale: row.locale,
      productsEnriched: num(row.products_enriched),
      productsTranslated: num(row.products_translated),
      fieldsTranslated: num(row.fields_translated),
      coveragePct: row.coverage_pct === null ? 0 : num(row.coverage_pct),
      outOfDate: num(row.out_of_date),
    })
  )

  const routingSavings: MetricsSavingsRowDto[] = savingsRows.map((row) => ({
    operation: row.operation,
    providerId: row.provider_id,
    model: row.model,
    calls: num(row.calls),
    actualCostMicros: num(row.actual_cost_micros),
    strongCostMicros: num(row.strong_cost_micros),
    savedMicros: num(row.saved_micros),
  }))

  return {
    rates,
    modelUsage,
    costOverTime,
    speed,
    translationCoverage,
    routingSavings,
  }
}
