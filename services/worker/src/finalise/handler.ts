/**
 * The `finalise` Stage handler: the last barrier. It reconciles the Row
 * Ledger so Done + Needs Review + Failed equals the sheet total — the only
 * source of "the counts add up" (GLOSSARY: Row Ledger) — flips the Import
 * to `completed` and publishes `import_done`.
 *
 * Reconciliation is assert-and-repair: Sheet Rows the ledger somehow lost
 * (a crash shape) are inserted as Failed with a loud reason (EC-126); a
 * mismatch that survives the repair is thrown — the Job retries and, if
 * the contract is truly broken, terminates Failed instead of the Import
 * silently lying about its counts. A merchant-fixable dead end stays
 * retryable from the dashboard.
 *
 * Idempotent (ADR-0003): the repair is conflict-nothing, the recount is
 * pure, and the completion is guarded (`status = 'running' AND stage =
 * 'finalise'`) — a redelivered Job converges and re-publishes nothing.
 */
import { sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import { createLogger } from "@workspace/log"
import type { Cache } from "@workspace/cache"

import { publishImportEvent } from "../events"
import type { JobContext, JobHandler } from "../handlers"

const log = createLogger({ service: "worker:finalise" })

const REPAIRED_ROW_REASON =
  "Row never reached a terminal state — finalise reconciled it as Failed. " +
  "Retry the import from the dashboard to reprocess it (EC-126)."

export interface FinaliseDeps {
  cache: Cache
}

export function createFinaliseHandler(deps: FinaliseDeps): JobHandler {
  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx

    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `finalise: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op
    if (imp.rowCount === null) {
      // Intake owns the row count; a finalise without one is a contract
      // violation no repair may paper over.
      throw new Error(
        `finalise: import ${job.importId} has no row count — intake never completed`
      )
    }

    await repairMissingLedgerRows(db, job.storeId, job.importId)

    const counts = await ledgerCounts(db, job.importId)
    const total = counts.done + counts.needsReview + counts.failed
    if (total !== imp.rowCount) {
      // Loud failure (EC-126: silently-missing products are the worst
      // failure class) — the Job retries; the Import stays unfinished.
      throw new Error(
        `finalise: ledger does not add up for import ${job.importId}: ` +
          `done ${counts.done} + needs_review ${counts.needsReview} + ` +
          `failed ${counts.failed} = ${total}, sheet says ${imp.rowCount}`
      )
    }

    await completeFinalise(db, deps.cache, job.importId, counts)

    log.info(`finalise completed`, {
      importId: job.importId,
      jobId: job.id,
      ...counts,
    })
  }
}

interface ImportRecord {
  id: string
  status: string
  rowCount: number | null
}

async function loadImport(
  db: Database,
  importId: string
): Promise<ImportRecord | null> {
  const rows = (await db.execute(sql`
    SELECT id, status::text AS status, row_count
    FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{
    id: string
    status: string
    row_count: number | null
  }>
  const row = rows[0]
  if (!row) return null
  return { id: row.id, status: row.status, rowCount: row.row_count }
}

/**
 * Assert-and-repair: Sheet Rows with no ledger entry are stranded — account
 * for them as Failed with a loud reason. Conflict-nothing, so a redelivered
 * Job converges (ADR-0003).
 */
async function repairMissingLedgerRows(
  db: Database,
  storeId: string,
  importId: string
): Promise<void> {
  await db.execute(sql`
    INSERT INTO row_ledger (store_id, import_id, row_index, state, failure_reason)
    SELECT ${storeId}, ${importId}, sr.row_index, 'failed',
           ${REPAIRED_ROW_REASON}
    FROM sheet_rows sr
    WHERE sr.import_id = ${importId}
      AND NOT EXISTS (
        SELECT 1 FROM row_ledger rl
        WHERE rl.import_id = sr.import_id AND rl.row_index = sr.row_index
      )
    ON CONFLICT (import_id, row_index) DO NOTHING
  `)
}

interface Counts {
  done: number
  needsReview: number
  failed: number
}

async function ledgerCounts(db: Database, importId: string): Promise<Counts> {
  const rows = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE state = 'done')::int AS done,
      count(*) FILTER (WHERE state = 'needs_review')::int AS needs_review,
      count(*) FILTER (WHERE state = 'failed')::int AS failed
    FROM row_ledger WHERE import_id = ${importId}
  `)) as unknown as Array<{
    done: number
    needs_review: number
    failed: number
  }>
  const row = rows[0]!
  return { done: row.done, needsReview: row.needs_review, failed: row.failed }
}

/**
 * Guarded completion — exactly one caller wins the flip and publishes
 * `import_done` with the reconciled counts (the same shape intake uses for
 * its stage flip; the event is the lossy feed, Postgres the truth).
 */
async function completeFinalise(
  db: Database,
  cache: Cache,
  importId: string,
  counts: Counts
): Promise<boolean> {
  const flipped = (await db.execute(sql`
    UPDATE imports SET
      status = 'completed',
      updated_at = now()
    WHERE id = ${importId} AND status = 'running' AND stage = 'finalise'
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  if (flipped.length === 0) return false
  await publishImportEvent(cache, {
    importId,
    type: "import_done",
    data: {
      importId,
      status: "completed",
      counts: {
        done: counts.done,
        needs_review: counts.needsReview,
        failed: counts.failed,
      },
    },
  })
  return true
}
