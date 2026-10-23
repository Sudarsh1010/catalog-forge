"use server"

/**
 * Server actions behind the Products review tab (user stories 22–24).
 *
 * The spec (#11) makes the tab a server-driven table: reads render in the
 * RSC page, writes go through these actions and revalidate the route so
 * the same roundtrip returns freshly rendered rows — no browser-bundle
 * query needed for anything the merchant can click.
 *
 * Each action mirrors the matching `lib/rpc.ts` procedure (same lib
 * primitives, same error semantics, contract-validated input) so the
 * oRPC surface and the server-action surface cannot drift: both are
 * exercised against the same DB of record and covered by
 * test/products.route.test.ts.
 */
import { revalidatePath } from "next/cache"
import { sql } from "drizzle-orm"

import type { ProductEditFields } from "@workspace/contracts"
import { ImportIdSchema, ProductEditFieldsSchema } from "@workspace/contracts"
import {
  DEFAULT_STORE_ID,
  SOURCE_LOCALE,
  TARGET_LOCALES,
} from "@workspace/pipeline"

import { getDb } from "@/lib/db"
import {
  editProduct,
  loadProductDetail,
  writePublications,
} from "@/lib/products"

const PUBLISHED_LOCALES = [SOURCE_LOCALE, ...TARGET_LOCALES]

const PRODUCT_NOT_FOUND_MESSAGE = "Product not found."
const NO_ENRICHMENT_MESSAGE =
  "This product has not been enriched yet — wait for the enrich stage to finish."
const UNKNOWN_PRODUCTS_MESSAGE =
  "Some selected products no longer exist — refresh the page and try again."

/** Actions return plain results; the client renders the message. */
export type ProductActionResult =
  | { ok: true }
  | { ok: true; publishedLocales: string[] }
  | { ok: false; message: string }

export type BulkApproveResult =
  | {
      ok: true
      approved: number
      skipped: Array<{ id: string; reason: string }>
    }
  | { ok: false; message: string }

export type BulkSendBackResult =
  | { ok: true; sentBack: number }
  | { ok: false; message: string }

/** The client components receive these as props (never imported directly —
 * a "use server" import from a client module destabilizes Turbopack dev). */
export interface ProductTabActions {
  bulkApprove: (ids: string[]) => Promise<BulkApproveResult>
  bulkSendBack: (ids: string[]) => Promise<BulkSendBackResult>
  approve: (id: string) => Promise<ProductActionResult>
  edit: (id: string, fields: ProductEditFields) => Promise<ProductActionResult>
  sendBack: (id: string) => Promise<ProductActionResult>
}

function revalidate(): void {
  // The write, the invalidation and the re-render land in one roundtrip:
  // the client sees fresh server-rendered rows without any refetch.
  revalidatePath("/products")
}

function actionError<E extends { ok: false; message: string }>(
  error: unknown,
  fallback: E
): E {
  return {
    ...fallback,
    message:
      error instanceof Error && error.message
        ? error.message
        : fallback.message,
  }
}

/**
 * Merchant edit (user story 23 + GLOSSARY: Origin): edited fields turn
 * `manual` and win over every later AI output. When the Product is
 * already approved the Publication snapshot refreshes in the same
 * transaction so the storefront never serves a stale rendering.
 */
export async function editProductAction(
  id: string,
  fields: ProductEditFields
): Promise<ProductActionResult> {
  try {
    const productId = ImportIdSchema.parse(id)
    const parsed = ProductEditFieldsSchema.parse(fields)
    const db = getDb().db
    const result = await db.transaction(async (tx) => {
      const edited = await editProduct(tx, productId, parsed)
      if (!edited.ok) return edited
      const published = (
        (await tx.execute(sql`
          SELECT count(*)::int AS count FROM publications
          WHERE product_id = ${productId}
        `)) as unknown as Array<{ count: number }>
      )[0]!.count
      if (published > 0) {
        await writePublications(tx, [productId])
        const refreshed = await loadProductDetail(tx, productId)
        if (refreshed) return { ok: true as const, product: refreshed }
      }
      return { ok: true as const, product: edited.product }
    })
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === "not_found"
            ? PRODUCT_NOT_FOUND_MESSAGE
            : NO_ENRICHMENT_MESSAGE,
      }
    }
    revalidate()
    return { ok: true }
  } catch (error) {
    return actionError(error, {
      ok: false,
      message: "The action could not be completed — try again.",
    })
  }
}

/** Approve one Product: writes its render-ready Publications (ADR-0005). */
export async function approveProductAction(
  id: string
): Promise<ProductActionResult> {
  try {
    const productId = ImportIdSchema.parse(id)
    const db = getDb().db
    await db.transaction(async (tx) => {
      const state = (
        (await tx.execute(sql`
          SELECT e.status FROM products p
          LEFT JOIN product_enrichments e ON e.product_id = p.id
          WHERE p.id = ${productId}
        `)) as unknown as Array<{ status: string | null }>
      )[0]
      if (state === undefined) throw new Error(PRODUCT_NOT_FOUND_MESSAGE)
      if (state.status === null) throw new Error(NO_ENRICHMENT_MESSAGE)
      await writePublications(tx, [productId])
    })
    revalidate()
    return { ok: true, publishedLocales: PUBLISHED_LOCALES }
  } catch (error) {
    return actionError(error, {
      ok: false,
      message: "The action could not be completed — try again.",
    })
  }
}

/**
 * Bulk approve (user story 24): one transaction, one set-based
 * Publications write for every enriched Product; un-enriched Products are
 * skipped and reported, never silently dropped.
 */
export async function bulkApproveProductsAction(
  ids: string[]
): Promise<BulkApproveResult> {
  try {
    const unique = [...new Set(ids)].map((id) => ImportIdSchema.parse(id))
    if (unique.length === 0) return { ok: true, approved: 0, skipped: [] }
    const db = getDb().db
    const result = await db.transaction(async (tx) => {
      const known = (await tx.execute(sql`
        SELECT id FROM products
        WHERE id IN (${sql.join(
          unique.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
      `)) as unknown as Array<{ id: string }>
      const knownIds = new Set(known.map((row) => row.id))
      if (knownIds.size !== unique.length) {
        throw new Error(UNKNOWN_PRODUCTS_MESSAGE)
      }

      const enriched = (await tx.execute(sql`
        SELECT product_id FROM product_enrichments
        WHERE product_id IN (${sql.join(
          unique.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
      `)) as unknown as Array<{ product_id: string }>
      const enrichedIds = new Set(enriched.map((row) => row.product_id))
      const approvable = unique.filter((id) => enrichedIds.has(id))
      const written = await writePublications(tx, approvable)
      return {
        approved: written.length,
        skipped: unique
          .filter((id) => !enrichedIds.has(id))
          .map((id) => ({ id, reason: "not enriched yet" })),
      }
    })
    revalidate()
    return { ok: true, ...result }
  } catch (error) {
    return actionError(error, {
      ok: false,
      message: "The action could not be completed — try again.",
    })
  }
}

/**
 * Send back (user story 23): writes the Re-run FACT the Worker adopts
 * (GLOSSARY: Re-run, ADR-0004) and retracts the Publications — a Product
 * under review is invisible by construction (ADR-0005).
 */
export async function sendBackProductAction(
  id: string
): Promise<ProductActionResult> {
  try {
    const productId = ImportIdSchema.parse(id)
    const db = getDb().db
    await db.transaction(async (tx) => {
      const product = (
        (await tx.execute(sql`
          SELECT import_id FROM products WHERE id = ${productId}
        `)) as unknown as Array<{ import_id: string }>
      )[0]
      if (product === undefined) {
        throw new Error(PRODUCT_NOT_FOUND_MESSAGE)
      }
      await tx.execute(sql`
        INSERT INTO reruns (store_id, import_id, stage, product_ids)
        VALUES (
          ${DEFAULT_STORE_ID},
          ${product.import_id},
          'enrich',
          ARRAY[${productId}::uuid]
        )
      `)
      await tx.execute(sql`
        DELETE FROM publications WHERE product_id = ${productId}
      `)
      await tx.execute(sql`
        UPDATE products SET
          needs_review = true,
          review_reason = 'Sent back by merchant — awaiting re-enrichment.',
          updated_at = now()
        WHERE id = ${productId}
      `)
    })
    revalidate()
    return { ok: true }
  } catch (error) {
    return actionError(error, {
      ok: false,
      message: "The action could not be completed — try again.",
    })
  }
}

/**
 * Bulk send back: one transaction writing ONE Re-run FACT carrying all
 * chosen Product ids (ADR-0004), retracting their Publications and
 * flagging them for review — the set-based form of sendBack. Idempotent:
 * already-sent-back Products just get re-flagged, nothing breaks.
 */
export async function bulkSendBackProductsAction(
  ids: string[]
): Promise<BulkSendBackResult> {
  try {
    const unique = [...new Set(ids)].map((id) => ImportIdSchema.parse(id))
    if (unique.length === 0) return { ok: true, sentBack: 0 }
    const db = getDb().db
    const result = await db.transaction(async (tx) => {
      const known = (await tx.execute(sql`
        SELECT id FROM products
        WHERE id IN (${sql.join(
          unique.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
      `)) as unknown as Array<{ id: string }>
      if (known.length !== unique.length) {
        throw new Error(UNKNOWN_PRODUCTS_MESSAGE)
      }

      // ONE reruns fact per import, carrying every chosen Product id —
      // never one fact per product (ADR-0004).
      await tx.execute(sql`
        INSERT INTO reruns (store_id, import_id, stage, product_ids)
        SELECT ${DEFAULT_STORE_ID}, p.import_id, 'enrich', ARRAY_AGG(p.id::uuid)
        FROM products p
        WHERE p.id IN (${sql.join(
          unique.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
        GROUP BY p.import_id
      `)
      await tx.execute(sql`
        DELETE FROM publications
        WHERE product_id IN (${sql.join(
          unique.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
      `)
      await tx.execute(sql`
        UPDATE products SET
          needs_review = true,
          review_reason = 'Sent back by merchant — awaiting re-enrichment.',
          updated_at = now()
        WHERE id IN (${sql.join(
          unique.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
      `)
      return { sentBack: unique.length }
    })
    revalidate()
    return { ok: true, ...result }
  } catch (error) {
    return actionError(error, {
      ok: false,
      message: "The action could not be completed — try again.",
    })
  }
}
