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

import { ImportDetailSchema, ImportDtoSchema, ImportIdSchema } from "./dto"

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

/** The full oRPC contract tree served by the app's procedures. */
export const contract = { import: importContract }

/** Client type helper (stable v1 name) so consumers can type oRPC clients. */
export type ClientContract = ContractRouterClient<typeof contract>
