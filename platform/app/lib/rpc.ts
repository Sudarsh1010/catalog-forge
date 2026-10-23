/**
 * The oRPC server surface for the Import namespace — the procedures behind
 * the `/api/rpc` mount. Contract-first: the shape lives in
 * `@workspace/contracts`, this file only implements the handlers (stable
 * oRPC v1 `implement` builder). Dashboard state stays read-only except for
 * the retry/re-run FACTS the Worker adopts (ADR-0004).
 */
import { implement, ORPCError } from "@orpc/server"
import { desc, eq, sql } from "drizzle-orm"

import { contract } from "@workspace/contracts"
import {
  DEFAULT_STORE_ID,
  SOURCE_LOCALE,
  TARGET_LOCALES,
} from "@workspace/pipeline"
import { imports } from "@workspace/db/schema"

import { getDb } from "@/lib/db"
import {
  editProduct,
  loadProductDetail,
  loadProductList,
  writePublications,
} from "@/lib/products"
import { loadImportDetail, toImportDto, UUID_RE } from "@/lib/imports"
import { loadMetricsOverview } from "@/lib/metrics"

const os = implement(contract)

const PRODUCT_NOT_FOUND = "PRODUCT_NOT_FOUND"
const NO_ENRICHMENT = "NO_ENRICHMENT"
const UNKNOWN_PRODUCTS = "UNKNOWN_PRODUCTS"

const PRODUCT_NOT_FOUND_MESSAGE = "Product not found."
const NO_ENRICHMENT_MESSAGE =
  "This product has not been enriched yet — wait for the enrich stage to finish."

function productNotFound() {
  return new ORPCError(PRODUCT_NOT_FOUND, {
    message: PRODUCT_NOT_FOUND_MESSAGE,
    status: 404,
  })
}

function noEnrichment() {
  return new ORPCError(NO_ENRICHMENT, {
    message: NO_ENRICHMENT_MESSAGE,
    status: 422,
  })
}

const PUBLISHED_LOCALES = [SOURCE_LOCALE, ...TARGET_LOCALES]

const appRouter = os.router({
  import: {
    /** The import queue, newest first (the dashboard's initial hydration). */
    list: os.import.list.handler(async () => {
      const db = getDb().db
      const rows = await db
        .select()
        .from(imports)
        .orderBy(desc(imports.createdAt))
        .limit(100)
      return { imports: rows.map(toImportDto) }
    }),

    /** Full detail snapshot — same shape as the SSE `snapshot` event. */
    detail: os.import.detail.handler(async ({ input }) => {
      const detail = await loadDetailOrThrow(input.id)
      return { import: detail }
    }),

    /**
     * Dashboard retry (Ticket 6 poison path): the app writes the retry FACT
     * — one `job_retries` row per terminally-failed Job — and the Worker's
     * Sweeper adopts it by requeuing the Job with reset attempts (ADR-0004:
     * the app never touches Job machinery). Idempotent: a Job with a
     * pending request is skipped (unique index), so double-clicks are
     * harmless.
     */
    retry: os.import.retry.handler(async ({ input }) => {
      const { id } = input
      const db = getDb().db

      if (!UUID_RE.test(id)) {
        throw new ORPCError("IMPORT_NOT_FOUND", {
          message: "Import not found.",
          status: 404,
        })
      }

      const existing = await db
        .select({ id: imports.id })
        .from(imports)
        .where(eq(imports.id, id))
        .limit(1)
      if (existing.length === 0) {
        throw new ORPCError("IMPORT_NOT_FOUND", {
          message: "Import not found.",
          status: 404,
        })
      }

      // Optional input: retry specific Jobs; absent/empty = every failed one.
      const jobIds = input.jobIds ?? []
      const jobFilter =
        jobIds.length > 0
          ? sql` AND j.id IN (${sql.join(
              jobIds.map((jobId) => sql`${jobId}::uuid`),
              sql`, `
            )})`
          : sql``
      const inserted = (await db.execute(sql`
        INSERT INTO job_retries (store_id, import_id, job_id)
        SELECT ${DEFAULT_STORE_ID}, j.import_id, j.id
        FROM jobs j
        WHERE j.import_id = ${id} AND j.status = 'failed'${jobFilter}
        ON CONFLICT (job_id) DO NOTHING
        RETURNING job_id
      `)) as unknown as Array<{ job_id: string }>

      return {
        requested: inserted.length,
        jobIds: inserted.map((row) => row.job_id),
      }
    }),

    /**
     * Re-run enrichment (GLOSSARY: Re-run): the app writes the FACT — one
     * `reruns` row carrying the chosen Products — and the Worker's Sweeper
     * adopts it by requeuing the enrich Jobs whose Batches cover those
     * Products with reset attempts (ADR-0004: the app never touches Job
     * machinery). Idempotent downstream: a second fact for already-pending
     * Jobs requeues nothing, so double-clicks are harmless.
     */
    rerun: os.import.rerun.handler(async ({ input }) => {
      const { id } = input
      const db = getDb().db

      if (!UUID_RE.test(id)) {
        throw new ORPCError("IMPORT_NOT_FOUND", {
          message: "Import not found.",
          status: 404,
        })
      }
      const existing = await db
        .select({ id: imports.id })
        .from(imports)
        .where(eq(imports.id, id))
        .limit(1)
      if (existing.length === 0) {
        throw new ORPCError("IMPORT_NOT_FOUND", {
          message: "Import not found.",
          status: 404,
        })
      }

      const productIds = [...new Set(input.productIds)]

      // Only Products of THIS Import are re-runnable — reject cross-Import
      // ids instead of adopting facts the Worker would silently no-op.
      const known = (await db.execute(sql`
        SELECT count(*)::int AS count FROM products
        WHERE import_id = ${id}
          AND id IN (${sql.join(
            productIds.map((productId) => sql`${productId}::uuid`),
            sql`, `
          )})
      `)) as unknown as Array<{ count: number }>
      if (known[0]!.count !== productIds.length) {
        // Defined in the contract's error map (status 422).
        throw new ORPCError("UNKNOWN_PRODUCTS", {
          status: 422,
          message:
            "Some products do not belong to this import — refresh the page and try again.",
        })
      }

      await db.execute(sql`
        INSERT INTO reruns (store_id, import_id, stage, product_ids)
        VALUES (
          ${DEFAULT_STORE_ID},
          ${id},
          'enrich',
          ARRAY[${sql.join(
            productIds.map((productId) => sql`${productId}::uuid`),
            sql`, `
          )}]::uuid[]
        )
      `)

      return {
        requested: productIds.length,
        productIds,
        stage: "enrich" as const,
      }
    }),
  },

  product: {
    /**
     * The catalog table (user story 20): server-driven pagination
     * (10/25/50/100), sort, search and filters. State lives in the query
     * string, never in client-side sorting — the totals travel beside the
     * rows so a 10k-row catalog pages without hauling every row over RPC.
     */
    list: os.product.list.handler(async ({ input }) =>
      loadProductList(getDb().db, input)
    ),

    /** The side-by-side hydration (user story 22). */
    detail: os.product.detail.handler(async ({ input }) => {
      const product = await loadProductDetail(getDb().db, input.id)
      if (!product) throw productNotFound()
      return { product }
    }),

    /**
     * Merchant edit (user story 23 + GLOSSARY: Origin): the edited fields
     * turn `manual` and win over every later AI output for the Product —
     * the enrich Stage's upsert preserves manual fields on re-run. When
     * the Product is already approved, the Publication snapshot refreshes
     * in the same transaction so the storefront never serves a stale
     * rendering of an edited product.
     */
    edit: os.product.edit.handler(async ({ input }) => {
      const db = getDb().db
      return db.transaction(async (tx) => {
        const result = await editProduct(tx, input.id, input.fields)
        if (!result.ok) {
          if (result.reason === "not_found") throw productNotFound()
          throw noEnrichment()
        }
        // Refresh the snapshot when this Product is already published — an
        // edited merchant field must not wait for a re-approval to ship.
        const published = (
          (await tx.execute(sql`
            SELECT count(*)::int AS count FROM publications
            WHERE product_id = ${input.id}
          `)) as unknown as Array<{ count: number }>
        )[0]!.count
        if (published > 0) {
          await writePublications(tx, [input.id])
          const refreshed = await loadProductDetail(tx, input.id)
          if (refreshed) return { product: refreshed }
        }
        return { product: result.product }
      })
    }),

    /**
     * Approve (user story 23): writes the render-ready Publications — the
     * only transition into the shopper-visible world (ADR-0005). Needs
     * Review Products CAN be approved: the human decision is the point.
     */
    approve: os.product.approve.handler(async ({ input }) => {
      const db = getDb().db
      return db.transaction(async (tx) => {
        const state = (
          (await tx.execute(sql`
            SELECT e.status FROM products p
            LEFT JOIN product_enrichments e ON e.product_id = p.id
            WHERE p.id = ${input.id}
          `)) as unknown as Array<{ status: string | null }>
        )[0]
        if (state === undefined) throw productNotFound()
        if (state.status === null) throw noEnrichment()
        await writePublications(tx, [input.id])
        return { productId: input.id, publishedLocales: PUBLISHED_LOCALES }
      })
    }),

    /**
     * Bulk approve (user story 24): one transaction, one set-based
     * Publications write for every enriched Product. Products without an
     * enrichment are skipped and reported, never silently dropped.
     */
    bulkApprove: os.product.bulkApprove.handler(async ({ input }) => {
      const db = getDb().db
      const ids = [...new Set(input.ids)]
      return db.transaction(async (tx) => {
        const known = await tx.execute(sql`
          SELECT id FROM products
          WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
        `)
        const knownIds = new Set(
          (known as unknown as Array<{ id: string }>).map((row) => row.id)
        )
        const missing = ids.filter((id) => !knownIds.has(id))
        if (missing.length > 0) {
          throw new ORPCError(UNKNOWN_PRODUCTS, {
            status: 422,
            message:
              "Some selected products no longer exist — refresh the page and try again.",
          })
        }

        const enriched = await tx.execute(sql`
          SELECT product_id FROM product_enrichments
          WHERE product_id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
        `)
        const enrichedIds = new Set(
          (enriched as unknown as Array<{ product_id: string }>).map(
            (row) => row.product_id
          )
        )
        const approvable = ids.filter((id) => enrichedIds.has(id))
        const written = await writePublications(tx, approvable)
        const skipped = ids
          .filter((id) => !enrichedIds.has(id))
          .map((id) => ({ id, reason: "not enriched yet" }))
        return {
          approved: written.length,
          productIds: written,
          skipped,
        }
      })
    }),

    /**
     * Send back (user story 23): writes the Re-run FACT the Worker adopts
     * (GLOSSARY: Re-run, ADR-0004) and retracts the Publications — a
     * Product under review is invisible by construction (ADR-0005), so a
     * reworked product stops shipping immediately.
     */
    sendBack: os.product.sendBack.handler(async ({ input }) => {
      const db = getDb().db
      return db.transaction(async (tx) => {
        const product = (await tx.execute(sql`
          SELECT import_id FROM products WHERE id = ${input.id}
        `)) as unknown as Array<{ import_id: string }>
        if (product.length === 0) throw productNotFound()
        await tx.execute(sql`
          INSERT INTO reruns (store_id, import_id, stage, product_ids)
          VALUES (
            ${DEFAULT_STORE_ID},
            ${product[0]!.import_id},
            'enrich',
            ARRAY[${input.id}::uuid]
          )
        `)
        await tx.execute(sql`
          DELETE FROM publications WHERE product_id = ${input.id}
        `)
        await tx.execute(sql`
          UPDATE products SET
            needs_review = true,
            review_reason = 'Sent back by merchant — awaiting re-enrichment.',
            updated_at = now()
          WHERE id = ${input.id}
        `)
        return { productId: input.id, requested: 1, stage: "enrich" as const }
      })
    }),

    /**
     * Bulk send back: one transaction, ONE Re-run FACT per Import carrying
     * every chosen Product id (ADR-0004 — never one fact per Product),
     * plus the set-based Publication retraction and review flagging that
     * single sendBack performs. Idempotent: already-sent-back Products are
     * simply re-flagged.
     */
    bulkSendBack: os.product.bulkSendBack.handler(async ({ input }) => {
      const db = getDb().db
      const ids = [...new Set(input.ids)]
      return db.transaction(async (tx) => {
        const known = await tx.execute(sql`
          SELECT id FROM products
          WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
        `)
        const knownIds = new Set(
          (known as unknown as Array<{ id: string }>).map((row) => row.id)
        )
        const missing = ids.filter((id) => !knownIds.has(id))
        if (missing.length > 0) {
          throw new ORPCError(UNKNOWN_PRODUCTS, {
            status: 422,
            message:
              "Some selected products no longer exist — refresh the page and try again.",
          })
        }

        await tx.execute(sql`
          INSERT INTO reruns (store_id, import_id, stage, product_ids)
          SELECT ${DEFAULT_STORE_ID}, p.import_id, 'enrich', ARRAY_AGG(p.id::uuid)
          FROM products p
          WHERE p.id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
          GROUP BY p.import_id
        `)
        await tx.execute(sql`
          DELETE FROM publications
          WHERE product_id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
        `)
        await tx.execute(sql`
          UPDATE products SET
            needs_review = true,
            review_reason = 'Sent back by merchant — awaiting re-enrichment.',
            updated_at = now()
          WHERE id IN (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `
          )})
        `)
        return {
          sentBack: ids.length,
          productIds: ids,
          skipped: [] as Array<{ id: string; reason: string }>,
        }
      })
    }),
  },

  metrics: {
    /** Metrics tab (ticket #19): one SELECT per Postgres view, no writes. */
    overview: os.metrics.overview.handler(async () =>
      loadMetricsOverview(getDb().db)
    ),
  },
})

export type AppRouter = typeof appRouter

/** Shared detail-or-error path for procedures that hydrate one Import. */
async function loadDetailOrThrow(id: string) {
  const detail = await loadImportDetail(getDb().db, id)
  if (!detail) {
    throw new ORPCError("IMPORT_NOT_FOUND", {
      message: "Import not found.",
      status: 404,
    })
  }
  return detail
}

export { appRouter }
