/**
 * Zod mirrors of the Import read models (`platform/app/lib/imports.ts`).
 * The dashboard state is read-only across the app↔worker contract
 * (ADR-0004): these schemas are the wire truth both sides validate.
 */
import { z } from "zod"

import { PIPELINE_STAGES, type Stage } from "@workspace/pipeline"

/** Merchant-fixable identifier guard for URL-provided Import ids. */
export const ImportIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "must be a UUID"
  )
export type ImportId = z.infer<typeof ImportIdSchema>

/** Live per-stage Job counts (GLOSSARY: Job — the Work Queue's states). */
export const StageJobCountsSchema = z.object({
  pending: z.number(),
  running: z.number(),
  completed: z.number(),
  failed: z.number(),
})
export type StageJobCounts = z.infer<typeof StageJobCountsSchema>

/**
 * Row Ledger accounting (GLOSSARY: Row Ledger — the only source of "the
 * counts add up"): every state count plus the unaccounted remainder, so
 * done + needsReview + failed + inProgress always equals the sheet total.
 */
export const ReconciliationSchema = z.object({
  /** Data rows of the sheet; `null` until intake lands them. */
  sheetRows: z.number().nullable(),
  done: z.number(),
  needsReview: z.number(),
  failed: z.number(),
  /** sheetRows minus the ledger's rows; 0 once everything is terminal. */
  inProgress: z.number().nullable(),
})
export type ReconciliationDto = z.infer<typeof ReconciliationSchema>

/** One failed Sheet Row: its reason and the Jobs that can retry it. */
export const RowErrorSchema = z.object({
  rowIndex: z.number(),
  reason: z.string(),
  ec: z.string().nullable(),
  /**
   * Terminally-failed enrich/translate Jobs whose Batch covers this row's
   * Product — the retry action requeues exactly these.
   */
  jobIds: z.array(z.string()),
})
export type RowErrorDto = z.infer<typeof RowErrorSchema>

/** An uploaded photo that matched no Product, with its reason. */
export const ParkedPhotoSchema = z.object({
  filename: z.string(),
  reason: z.string(),
  ec: z.string().nullable(),
})
export type ParkedPhotoDto = z.infer<typeof ParkedPhotoSchema>

/** One Product with its enrichment state — the re-run selection surface. */
export const ProductRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  naturalKey: z.string(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  enrichmentStatus: z.enum(["ready", "needs_review"]).nullable(),
  enrichedAt: z.string().nullable(),
})
export type ProductRowDto = z.infer<typeof ProductRowSchema>

/**
 * One localized field of one Product (GLOSSARY: Origin, Out of Date):
 * `origin` says who produced it (manual always wins), `outOfDate` flags a
 * translation whose English source changed after it was made.
 */
export const TranslationRowSchema = z.object({
  productId: z.string(),
  productTitle: z.string(),
  locale: z.string(),
  field: z.string(),
  origin: z.enum(["ai", "manual"]),
  outOfDate: z.boolean(),
  updatedAt: z.string().nullable(),
})
export type TranslationRowDto = z.infer<typeof TranslationRowSchema>

/** One Import as the browser sees it: read-only projection (ADR-0004). */
export const ImportDtoSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  status: z.string(),
  stage: z.string(),
  originalFilename: z.string(),
  sheetFormat: z.string(),
  rowCount: z.number().nullable(),
  failureReason: z.string().nullable(),
  /** Pause surface (GLOSSARY: Pause): "Paused — resuming in X minutes". */
  pausedProviderId: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  contentHash: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ImportDto = z.infer<typeof ImportDtoSchema>

/**
 * Per-Import page hydration: per-stage Job counts keyed by every pipeline
 * Stage, the Row Ledger reconciliation, and the paged error/parked/product
 * tables whose totals travel beside the rows (10k-row Import page caps).
 */
export const ImportDetailSchema = ImportDtoSchema.extend({
  stages: z.object(
    Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage, StageJobCountsSchema])
    ) as Record<Stage, typeof StageJobCountsSchema>
  ),
  reconciliation: ReconciliationSchema,
  errors: z.object({ rows: z.array(RowErrorSchema), total: z.number() }),
  parkedPhotos: z.object({
    rows: z.array(ParkedPhotoSchema),
    total: z.number(),
  }),
  products: z.object({ rows: z.array(ProductRowSchema), total: z.number() }),
  /** Per-translation surface incl. the Out-of-Date state (ticket #15). */
  translations: z.object({
    rows: z.array(TranslationRowSchema),
    total: z.number(),
    outOfDate: z.number(),
  }),
})
export type ImportDetailDto = z.infer<typeof ImportDetailSchema>

/**
 * Response of the plain upload route, shared so the client uploader and
 * the route can never drift; `deduped` flags contentHash reuse instead of
 * a fresh Import.
 */
export const UploadResultSchema = z.object({
  import: ImportDtoSchema,
  deduped: z.boolean(),
})
export type UploadResult = z.infer<typeof UploadResultSchema>

/**
 * Metrics-tab read models (ticket #19): every block mirrors one Postgres
 * view (core/db/drizzle/0013_metrics_views.sql) — the dashboard aggregates,
 * it never re-derives from base tables.
 */

/** Row Ledger processing rates per store (view: metrics_import_rates). */
export const MetricsRatesSchema = z.object({
  totalRows: z.number(),
  doneRows: z.number(),
  needsReviewRows: z.number(),
  failedRows: z.number(),
  donePct: z.number(),
  needsReviewPct: z.number(),
  failedPct: z.number(),
})
export type MetricsRatesDto = z.infer<typeof MetricsRatesSchema>

/** Per provider/model/operation usage (view: metrics_model_usage). */
export const MetricsModelUsageRowSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  operation: z.string(),
  calls: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  costMicros: z.number(),
})
export type MetricsModelUsageRowDto = z.infer<typeof MetricsModelUsageRowSchema>

/** Cost per UTC day (view: metrics_cost_daily). */
export const MetricsCostDaySchema = z.object({
  day: z.string(),
  calls: z.number(),
  costMicros: z.number(),
})
export type MetricsCostDayDto = z.infer<typeof MetricsCostDaySchema>

/** Average and slowest call duration per model/provider. */
export const MetricsSpeedRowSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  operation: z.string(),
  calls: z.number(),
  avgDurationMs: z.number().nullable(),
  slowestDurationMs: z.number().nullable(),
})
export type MetricsSpeedRowDto = z.infer<typeof MetricsSpeedRowSchema>

/** Per-locale coverage with the Out-of-Date count. */
export const MetricsCoverageRowSchema = z.object({
  locale: z.string(),
  productsEnriched: z.number(),
  productsTranslated: z.number(),
  fieldsTranslated: z.number(),
  coveragePct: z.number(),
  outOfDate: z.number(),
})
export type MetricsCoverageRowDto = z.infer<typeof MetricsCoverageRowSchema>

/** Cheap/strong routing savings per model (view: metrics_routing_savings). */
export const MetricsSavingsRowSchema = z.object({
  operation: z.string(),
  providerId: z.string(),
  model: z.string(),
  calls: z.number(),
  actualCostMicros: z.number(),
  strongCostMicros: z.number(),
  savedMicros: z.number(),
})
export type MetricsSavingsRowDto = z.infer<typeof MetricsSavingsRowSchema>

/** The full Metrics-tab payload — one view per block. */
export const MetricsOverviewSchema = z.object({
  rates: MetricsRatesSchema,
  modelUsage: z.array(MetricsModelUsageRowSchema),
  costOverTime: z.array(MetricsCostDaySchema),
  speed: z.array(MetricsSpeedRowSchema),
  translationCoverage: z.array(MetricsCoverageRowSchema),
  routingSavings: z.array(MetricsSavingsRowSchema),
})
export type MetricsOverviewDto = z.infer<typeof MetricsOverviewSchema>
