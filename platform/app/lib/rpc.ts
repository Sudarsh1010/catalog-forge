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
import { DEFAULT_STORE_ID } from "@workspace/pipeline"
import { imports } from "@workspace/db/schema"

import { getDb } from "@/lib/db"
import { loadImportDetail, toImportDto, UUID_RE } from "@/lib/imports"
import { loadMetricsOverview } from "@/lib/metrics"

const os = implement(contract)

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
