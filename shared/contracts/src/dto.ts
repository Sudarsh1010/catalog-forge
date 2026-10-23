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

// ------------------------------------------------------------- products --
// The Products review tab (spec user stories 20–24). Same read-model rules
// as the Import namespace (ADR-0004), plus the review actions: an edit
// stores Origin, approval writes Publications (ADR-0005), send-back writes
// the Re-run fact the Worker adopts.

/** Page sizes the Products tab offers (user story 20). */
export const PRODUCT_PAGE_SIZES = [10, 25, 50, 100] as const
export const ProductPageSizeSchema = z
  .number()
  .int()
  .refine(
    (value): value is (typeof PRODUCT_PAGE_SIZES)[number] =>
      (PRODUCT_PAGE_SIZES as readonly number[]).includes(value),
    "must be one of 10, 25, 50, 100"
  )

/** Sort keys; `title` falls back to the grouping title pre-enrichment. */
export const PRODUCT_SORTS = [
  "title",
  "status",
  "confidence",
  "messiness",
  "updatedAt",
] as const
export const ProductSortSchema = z.enum(PRODUCT_SORTS)
export type ProductSort = z.infer<typeof ProductSortSchema>

/** Derived review state of one Product. `pending` = not enriched yet. */
export const PRODUCT_STATUSES = [
  "approved",
  "needs_review",
  "ready",
  "pending",
] as const
export const ProductStatusSchema = z.enum(PRODUCT_STATUSES)
export type ProductStatus = z.infer<typeof ProductStatusSchema>

/** Status filter values: every derived state plus `all`. */
export const PRODUCT_STATUS_FILTERS = ["all", ...PRODUCT_STATUSES] as const
export const ProductStatusFilterSchema = z.enum(PRODUCT_STATUS_FILTERS)
export type ProductStatusFilter = z.infer<typeof ProductStatusFilterSchema>

/**
 * Confidence buckets (GLOSSARY: Confidence 0–100). The boundaries are the
 * review threshold the providers gate on: < 70 is low (red), 70–89 medium
 * (amber), ≥ 90 high (green) — the same cut the colour coding uses.
 */
export const CONFIDENCE_LOW_BELOW = 70
export const CONFIDENCE_HIGH_FROM = 90
export const PRODUCT_CONFIDENCE_FILTERS = [
  "all",
  "low",
  "medium",
  "high",
] as const
export const ProductConfidenceFilterSchema = z.enum(PRODUCT_CONFIDENCE_FILTERS)
export type ProductConfidenceFilter = z.infer<
  typeof ProductConfidenceFilterSchema
>

/** One Products-tab row: the review surface's list projection. */
export const ProductListRowSchema = z.object({
  id: z.string(),
  importId: z.string(),
  importFilename: z.string(),
  naturalKey: z.string(),
  /** Enriched title, falling back to the grouping title. */
  title: z.string(),
  handle: z.string().nullable(),
  status: ProductStatusSchema,
  /** Enrichment review reasons still standing (empty once addressed). */
  reviewReasons: z.array(z.string()),
  /** Per-field Confidence 0–100 (GLOSSARY); empty pre-enrichment. */
  confidence: z.record(z.string(), z.number()),
  /** The weakest field's Confidence — the row's colour driver. */
  minConfidence: z.number().nullable(),
  messiness: z.number().nullable(),
  sourceRowCount: z.number(),
  photoCount: z.number(),
  /** True when the merchant edited at least one field (GLOSSARY: Origin). */
  editedByMerchant: z.boolean(),
  /** Locales a Publication exists for — non-empty means approved. */
  publishedLocales: z.array(z.string()),
  updatedAt: z.string(),
})
export type ProductListRow = z.infer<typeof ProductListRowSchema>

export const ProductListResultSchema = z.object({
  rows: z.array(ProductListRowSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
})
export type ProductListResult = z.infer<typeof ProductListResultSchema>

/** One Sheet Row exactly as parsed (GLOSSARY: Sheet Row) — the left pane. */
export const SourceRowSchema = z.object({
  rowIndex: z.number(),
  cells: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export type SourceRowDto = z.infer<typeof SourceRowSchema>

/** One Variant of the Product (GLOSSARY: Variant). */
export const ProductVariantSchema = z.object({
  id: z.string(),
  sku: z.string().nullable(),
  gtin: z.string().nullable(),
  priceCents: z.number().nullable(),
  priceCurrency: z.string().nullable(),
  attributes: z.record(z.string(), z.string()),
  imageRef: z.string().nullable(),
  sourceRowIndex: z.number(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  /** True when a re-import no longer contains this Variant's source row. */
  missingFromSource: z.boolean(),
})
export type ProductVariantDto = z.infer<typeof ProductVariantSchema>

/** One photo matched to the Product, with its match evidence. */
export const ProductPhotoSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  /** Storage object key — the panel streams it via `/api/photos/[fileId]`. */
  objectKey: z.string(),
  matchedVia: z.string(),
  matchedToken: z.string(),
})
export type ProductPhotoDto = z.infer<typeof ProductPhotoSchema>

/** One Claim with its exact source pointer (GLOSSARY: Claim). */
export const ClaimSchema = z.object({
  text: z.string(),
  sourceRowIndex: z.number(),
})
export type ClaimDto = z.infer<typeof ClaimSchema>

/** The AI result side of the side-by-side panel. */
export const ProductEnrichmentSchema = z.object({
  title: z.string(),
  handle: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  confidence: z.record(z.string(), z.number()),
  /** Per-field Origin (GLOSSARY): `manual` fields win over later AI output. */
  fieldOrigins: z.record(z.string(), z.enum(["ai", "manual"])),
  status: z.enum(["ready", "needs_review"]),
  reviewReasons: z.array(z.string()),
  claims: z.array(ClaimSchema),
  sourceRowIndexes: z.array(z.number()),
  messiness: z.number(),
  updatedAt: z.string(),
})
export type ProductEnrichmentDto = z.infer<typeof ProductEnrichmentSchema>

/** One localized field translation with its Origin and staleness. */
export const ProductTranslationSchema = z.object({
  locale: z.string(),
  field: z.string(),
  text: z.string(),
  origin: z.enum(["ai", "manual"]),
  outOfDate: z.boolean(),
})
export type ProductTranslationDto = z.infer<typeof ProductTranslationSchema>

/** Full side-by-side hydration for one Product. */
export const ProductDetailSchema = z.object({
  id: z.string(),
  importId: z.string(),
  importFilename: z.string(),
  naturalKey: z.string(),
  identityKind: z.enum(["code", "title"]),
  brand: z.string().nullable(),
  gtin: z.string().nullable(),
  createdAt: z.string(),
  status: ProductStatusSchema,
  enrichment: ProductEnrichmentSchema.nullable(),
  sheetHeader: z.array(z.string()),
  sourceRows: z.array(SourceRowSchema),
  variants: z.array(ProductVariantSchema),
  photos: z.array(ProductPhotoSchema),
  translations: z.array(ProductTranslationSchema),
  /** Non-null once approved (GLOSSARY: Publication). */
  publication: z
    .object({ locales: z.array(z.string()), publishedAt: z.string() })
    .nullable(),
})
export type ProductDetailDto = z.infer<typeof ProductDetailSchema>

/** The fields a merchant may edit; at least one must be present. */
export const ProductEditFieldsSchema = z
  .object({
    title: z.string().min(1).max(500),
    handle: z.string().min(1).max(500),
    description: z.string().max(20_000),
    category: z.string().max(500),
    tags: z.array(z.string().min(1).max(200)).max(50),
    attributes: z.record(z.string().min(1).max(200), z.string().max(2000)),
  })
  .partial()
  .refine(
    (fields) => Object.values(fields).some((value) => value !== undefined),
    "at least one field is required"
  )
export type ProductEditFields = z.infer<typeof ProductEditFieldsSchema>
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

/** Variants a re-import dropped, per store (view: metrics_missing_from_source). */
export const MetricsMissingFromSourceRowSchema = z.object({
  storeId: z.string(),
  missingVariants: z.number(),
})
export type MetricsMissingFromSourceRowDto = z.infer<
  typeof MetricsMissingFromSourceRowSchema
>

/** The full Metrics-tab payload — one view per block. */
export const MetricsOverviewSchema = z.object({
  rates: MetricsRatesSchema,
  modelUsage: z.array(MetricsModelUsageRowSchema),
  costOverTime: z.array(MetricsCostDaySchema),
  speed: z.array(MetricsSpeedRowSchema),
  translationCoverage: z.array(MetricsCoverageRowSchema),
  routingSavings: z.array(MetricsSavingsRowSchema),
  missingFromSource: z.array(MetricsMissingFromSourceRowSchema),
})
export type MetricsOverviewDto = z.infer<typeof MetricsOverviewSchema>
