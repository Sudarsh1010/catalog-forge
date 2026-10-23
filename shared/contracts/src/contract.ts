/**
 * oRPC contract-first surface for the Import namespace (stable oRPC v1
 * `oc` builder). Procedures are pure contracts — the Next.js app will
 * implement them server-side and consume them client-side; no handlers
 * live here. Shared with the Worker via the read-only DTOs (ADR-0004):
 * retry/re-run are written by the app as facts the Worker adopts.
 */
import { oc } from "@orpc/contract"
import type { ContractRouterClient } from "@orpc/contract"
import { z } from "zod"

import {
  ImportDetailSchema,
  ImportDtoSchema,
  ImportIdSchema,
  MetricsOverviewSchema,
  ProductConfidenceFilterSchema,
  ProductDetailSchema,
  ProductEditFieldsSchema,
  ProductListResultSchema,
  ProductPageSizeSchema,
  ProductSortSchema,
  ProductStatusFilterSchema,
} from "./dto"

/** Defined payload-free error for a missing or malformed Import id. */
const IMPORT_NOT_FOUND_ERRORS = {
  IMPORT_NOT_FOUND: { message: "Import not found.", status: 404 },
} as const

/** Cross-Import product selection on re-run — rejected, never adopted. */
const UNKNOWN_PRODUCTS_ERRORS = {
  UNKNOWN_PRODUCTS: {
    message:
      "Some products do not belong to this import — refresh the page and try again.",
    status: 422,
  },
} as const

/** Missing or malformed Product id, or a Product that does not exist. */
const PRODUCT_NOT_FOUND_ERRORS = {
  PRODUCT_NOT_FOUND: { message: "Product not found.", status: 404 },
} as const

/** Review actions need the enrich Stage's output to act on. */
const NO_ENRICHMENT_ERRORS = {
  NO_ENRICHMENT: {
    message:
      "This product has not been enriched yet — wait for the enrich stage to finish.",
    status: 422,
  },
} as const

/**
 * `import` is a reserved word, so the namespace is built as
 * `importContract` and re-exported as `contract`.
 */
const importContract = {
  /** Paginated dashboard list of Imports. */
  list: oc.output(z.object({ imports: z.array(ImportDtoSchema) })),

  /** Full detail snapshot — same shape as the SSE `snapshot` event. */
  detail: oc
    .input(z.object({ id: ImportIdSchema }))
    .output(z.object({ import: ImportDetailSchema }))
    .errors(IMPORT_NOT_FOUND_ERRORS),

  /**
   * Requeue terminally-failed Jobs. `jobIds` absent or empty means "all
   * terminally-failed Jobs of the Import". App writes the fact, Worker
   * adopts — ADR-0004.
   */
  retry: oc
    .input(
      z.object({
        id: ImportIdSchema,
        jobIds: z.array(ImportIdSchema).optional(),
      })
    )
    .output(z.object({ requested: z.number(), jobIds: z.array(z.string()) }))
    .errors(IMPORT_NOT_FOUND_ERRORS),

  /** Re-run selected Products from the enrich Stage (GLOSSARY: Re-run). */
  rerun: oc
    .input(
      z.object({
        id: ImportIdSchema,
        productIds: z.array(ImportIdSchema).min(1),
      })
    )
    .output(
      z.object({
        requested: z.number(),
        productIds: z.array(z.string()),
        stage: z.literal("enrich"),
      })
    )
    .errors({ ...IMPORT_NOT_FOUND_ERRORS, ...UNKNOWN_PRODUCTS_ERRORS }),
}

/**
 * The Products review tab (user stories 20–24): a server-driven catalog
 * table plus the review actions. Reads span every Import of the Store;
 * writes stay inside ADR-0004's rule — the app writes facts and the
 * render-ready Publication snapshot, never Job machinery.
 */
const productContract = {
  /** Paginated, sorted, searched, filtered catalog table. */
  list: oc
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        pageSize: ProductPageSizeSchema.default(25),
        sort: ProductSortSchema.default("updatedAt"),
        dir: z.enum(["asc", "desc"]).default("desc"),
        search: z.string().max(200).optional(),
        status: ProductStatusFilterSchema.default("all"),
        confidence: ProductConfidenceFilterSchema.default("all"),
        importId: ImportIdSchema.optional(),
      })
    )
    .output(ProductListResultSchema),

  /** Side-by-side hydration: source rows + photos vs the AI result. */
  detail: oc
    .input(z.object({ id: ImportIdSchema }))
    .output(z.object({ product: ProductDetailSchema }))
    .errors(PRODUCT_NOT_FOUND_ERRORS),

  /**
   * Persist merchant edits on the enriched fields (GLOSSARY: Origin) —
   * a manual field wins over every later AI output for that Product.
   */
  edit: oc
    .input(z.object({ id: ImportIdSchema, fields: ProductEditFieldsSchema }))
    .output(z.object({ product: ProductDetailSchema }))
    .errors({ ...PRODUCT_NOT_FOUND_ERRORS, ...NO_ENRICHMENT_ERRORS }),

  /** Approve one Product: writes its Publications, one row per locale. */
  approve: oc
    .input(z.object({ id: ImportIdSchema }))
    .output(
      z.object({ productId: z.string(), publishedLocales: z.array(z.string()) })
    )
    .errors({ ...PRODUCT_NOT_FOUND_ERRORS, ...NO_ENRICHMENT_ERRORS }),

  /** Bulk approve (user story 24); un-enriched Products are skipped. */
  bulkApprove: oc
    .input(z.object({ ids: z.array(ImportIdSchema).min(1).max(5000) }))
    .output(
      z.object({
        approved: z.number(),
        productIds: z.array(z.string()),
        skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
      })
    )
    .errors({ ...PRODUCT_NOT_FOUND_ERRORS, ...UNKNOWN_PRODUCTS_ERRORS }),

  /**
   * Bulk send back: one transaction writing ONE Re-run FACT carrying all
   * chosen Product ids (ADR-0004), retracting their Publications and
   * flagging them for review — the set-based form of sendBack.
   */
  bulkSendBack: oc
    .input(z.object({ ids: z.array(ImportIdSchema).min(1).max(5000) }))
    .output(
      z.object({
        sentBack: z.number(),
        productIds: z.array(z.string()),
        skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
      })
    )
    .errors({ ...PRODUCT_NOT_FOUND_ERRORS, ...UNKNOWN_PRODUCTS_ERRORS }),

  /**
   * Send one Product back for re-enrichment: writes the Re-run FACT
   * (GLOSSARY: Re-run, ADR-0004) and retracts its Publications — a
   * Product under review is invisible by construction (ADR-0005).
   */
  sendBack: oc
    .input(z.object({ id: ImportIdSchema }))
    .output(
      z.object({
        productId: z.string(),
        requested: z.literal(1),
        stage: z.literal("enrich"),
      })
    )
    .errors(PRODUCT_NOT_FOUND_ERRORS),
}

/** The full oRPC contract tree served by the app's procedures. */
export const contract = {
  import: importContract,
  product: productContract,
  /** Metrics tab (ticket #19): every block reads one Postgres view. */
  metrics: {
    overview: oc.output(MetricsOverviewSchema),
  },
}

/** Client type helper (stable v1 name) so consumers can type oRPC clients. */
export type ClientContract = ContractRouterClient<typeof contract>
