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
