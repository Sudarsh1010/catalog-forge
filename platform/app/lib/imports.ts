/**
 * Import read models shared by the oRPC procedures and the SSE snapshot. The
 * dashboard state is read-only across the app↔worker contract (ADR-0004):
 * these shapes are what the browser sees. The DTOs are the single source of
 * truth in @workspace/contracts.
 */
import type {
  ImportDetailDto,
  ImportDto,
  ReconciliationDto,
  StageJobCounts,
} from "@workspace/contracts"
import type { Import } from "@workspace/db/schema"

export type {
  ImportDto,
  StageJobCounts,
  ReconciliationDto,
  RowErrorDto,
  ParkedPhotoDto,
  ProductRowDto,
  ImportDetailDto,
} from "@workspace/contracts"

export function toImportDto(row: Import): ImportDto {
  return {
    id: row.id,
    storeId: row.storeId,
    status: row.status,
    stage: row.stage,
    originalFilename: row.originalFilename,
    sheetFormat: row.sheetFormat,
    rowCount: row.rowCount,
    failureReason: row.failureReason,
    pausedProviderId: row.pausedProviderId,
    pausedUntil: row.pausedUntil?.toISOString() ?? null,
    contentHash: row.contentHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ----------------------------------------------------------- detail view --
// The per-Import page's hydration: per-stage Job counts, the Row Ledger
// reconciliation against the sheet total, per-row errors with their
// retryable Jobs, Parked Photos, and the Products a merchant can re-run.
// Read-only across the app↔worker contract (ADR-0004): aggregates over
// worker-owned tables, never writes.

import {
  PIPELINE_STAGES,
  PRODUCT_BATCH_KEY_PATTERN,
  PRODUCT_BATCH_KEY_PREFIX_PATTERN,
  type Stage,
} from "@workspace/pipeline"
import type { Database } from "@workspace/db"
import { eq, sql } from "drizzle-orm"

import { imports } from "@workspace/db/schema"

/** Merchant-fixable identifier guard for URL-provided Import ids. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Caps so a 10k-row Import cannot sink the page; totals travel beside. */
const ERROR_PAGE_SIZE = 100
const PARKED_PAGE_SIZE = 100
const PRODUCT_PAGE_SIZE = 200

function emptyStageCounts(): Record<Stage, StageJobCounts> {
  return Object.fromEntries(
    PIPELINE_STAGES.map((stage) => [
      stage,
      { pending: 0, running: 0, completed: 0, failed: 0 },
    ])
  ) as Record<Stage, StageJobCounts>
}

function rowsOf<T>(result: unknown): T[] {
  return result as T[]
}

/**
 * Raw-SQL timestamps surface as `Date` or driver string depending on the
 * runtime's module identity — coerce at the DTO boundary, never trust one.
 */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

/**
 * Load the full detail snapshot for one Import — the shape of both the
 * detail route's JSON and the SSE stream's first (`snapshot`) event.
 * Returns `null` for unknown or malformed ids.
 */
export async function loadImportDetail(
  db: Database,
  id: string
): Promise<ImportDetailDto | null> {
  if (!UUID_RE.test(id)) return null
  const importRows = await db
    .select()
    .from(imports)
    .where(eq(imports.id, id))
    .limit(1)
  const row = importRows[0]
  if (!row) return null

  // Per-stage Job counts — the Work Queue's states, grouped (one query).
  const stageRows = rowsOf<{
    stage: string
    status: string
    count: number
  }>(
    await db.execute(sql`
      SELECT stage, status::text AS status, count(*)::int AS count
      FROM jobs WHERE import_id = ${id}
      GROUP BY stage, status
    `)
  )
  const stages = emptyStageCounts()
  for (const entry of stageRows) {
    const counts = stages[entry.stage as Stage]
    if (counts && entry.status in counts) {
      counts[entry.status as keyof StageJobCounts] = entry.count
    }
  }

  // Row Ledger reconciliation — the states plus the sheet total.
  const ledgerRows = rowsOf<{ state: string; count: number }>(
    await db.execute(sql`
      SELECT state::text AS state, count(*)::int AS count
      FROM row_ledger WHERE import_id = ${id}
      GROUP BY state
    `)
  )
  const byState = new Map(ledgerRows.map((entry) => [entry.state, entry.count]))
  const done = byState.get("done") ?? 0
  const needsReview = byState.get("needs_review") ?? 0
  const failed = byState.get("failed") ?? 0
  const reconciliation: ReconciliationDto = {
    sheetRows: row.rowCount,
    done,
    needsReview,
    failed,
    inProgress:
      row.rowCount === null
        ? null
        : Math.max(0, row.rowCount - (done + needsReview + failed)),
  }

  // Failed rows with the retryable Jobs covering each row's Product. The
  // Batch ordinals are the same deterministic natural-key-hash order the
  // planner and the enrich/translate handlers read (ADR-0002).
  const errorRows = rowsOf<{
    total: number
    row_index: number
    failure_reason: string
    failure_ec: string | null
    job_ids: string[] | null
  }>(
    await db.execute(sql`
      WITH failed_rows AS (
        SELECT row_index, failure_reason, failure_ec, product_id
        FROM row_ledger
        WHERE import_id = ${id} AND state = 'failed'
        ORDER BY row_index
        LIMIT ${ERROR_PAGE_SIZE}
      ),
      totals AS (
        SELECT count(*)::int AS total FROM row_ledger
        WHERE import_id = ${id} AND state = 'failed'
      ),
      scored AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY natural_key_hash) AS ordinal
        FROM products WHERE import_id = ${id}
      ),
      failed_jobs AS (
        SELECT id,
               (regexp_match(batch_key, ${PRODUCT_BATCH_KEY_PATTERN}))[1]::int AS lo,
               (regexp_match(batch_key, ${PRODUCT_BATCH_KEY_PATTERN}))[2]::int AS hi
        FROM jobs
        WHERE import_id = ${id} AND status = 'failed'
          AND batch_key ~ ${PRODUCT_BATCH_KEY_PREFIX_PATTERN}
      )
      SELECT
        (SELECT total FROM totals) AS total,
        fr.row_index,
        fr.failure_reason,
        fr.failure_ec,
        COALESCE(
          array_agg(DISTINCT fj.id) FILTER (WHERE fj.id IS NOT NULL), '{}'
        ) AS job_ids
      FROM failed_rows fr
      LEFT JOIN scored s ON s.id = fr.product_id
      LEFT JOIN failed_jobs fj ON s.ordinal BETWEEN fj.lo AND fj.hi
      GROUP BY fr.row_index, fr.failure_reason, fr.failure_ec
      ORDER BY fr.row_index
    `)
  )

  // Parked Photos (GLOSSARY) with their match-failure reasons.
  const parkedRows = rowsOf<{
    filename: string
    reason: string
    ec: string | null
  }>(
    await db.execute(sql`
      SELECT f.filename, pp.reason, pp.ec
      FROM parked_photos pp
      JOIN import_files f ON f.id = pp.import_file_id
      WHERE pp.import_id = ${id}
      ORDER BY pp.created_at, pp.id
      LIMIT ${PARKED_PAGE_SIZE}
    `)
  )
  const parkedTotal = rowsOf<{ count: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS count FROM parked_photos WHERE import_id = ${id}
    `)
  )[0]!.count

  // Products — the re-run selection surface, in the deterministic order.
  const productRows = rowsOf<{
    id: string
    title: string
    natural_key: string
    needs_review: boolean
    review_reason: string | null
    enrichment_status: string | null
    enriched_at: Date | string | null
  }>(
    await db.execute(sql`
      SELECT p.id, p.title, p.natural_key, p.needs_review, p.review_reason,
             e.status::text AS enrichment_status, e.updated_at AS enriched_at
      FROM products p
      LEFT JOIN product_enrichments e ON e.product_id = p.id
      WHERE p.import_id = ${id}
      ORDER BY p.natural_key_hash
      LIMIT ${PRODUCT_PAGE_SIZE}
    `)
  )
  const productTotal = rowsOf<{ count: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS count FROM products WHERE import_id = ${id}
    `)
  )[0]!.count

  return {
    ...toImportDto(row),
    stages,
    reconciliation,
    errors: {
      total: errorRows[0]?.total ?? 0,
      rows: errorRows.map((entry) => ({
        rowIndex: entry.row_index,
        reason: entry.failure_reason,
        ec: entry.failure_ec,
        jobIds: entry.job_ids ?? [],
      })),
    },
    parkedPhotos: {
      total: parkedTotal,
      rows: parkedRows.map((entry) => ({
        filename: entry.filename,
        reason: entry.reason,
        ec: entry.ec,
      })),
    },
    products: {
      total: productTotal,
      rows: productRows.map((entry) => ({
        id: entry.id,
        title: entry.title,
        naturalKey: entry.natural_key,
        needsReview: entry.needs_review,
        reviewReason: entry.review_reason,
        enrichmentStatus:
          (entry.enrichment_status as "ready" | "needs_review" | null) ?? null,
        enrichedAt: toIso(entry.enriched_at),
      })),
    },
  }
}
