/**
 * The `intake` Stage handler (the first Stage of the fixed machine).
 *
 * Downloads the sheet from object storage, stream-parses it (CSV or XLSX),
 * lands Sheet Rows as immutable raw JSONB, hashes every photo (loose files
 * and ZIP entries — extraction, entry-name validation and decompression
 * caps all happen here, never in the web request), and advances the Import
 * to the next Stage on completion.
 *
 * Merchant-fixable failures (EC-006/EC-008 class) fail the Import with a
 * clear reason and complete the Job — retrying a corrupt file can never
 * succeed. Transient errors (storage, network, database) are rethrown for
 * the lease machinery (ADR-0003).
 */
import { and, eq, isNull } from "drizzle-orm"
import { rm } from "node:fs/promises"

import type { Database } from "@workspace/db"
import type { SheetCell } from "@workspace/db/schema"
import { importFiles, imports, sheetRows } from "@workspace/db/schema"
import type { Cache } from "@workspace/cache"
import { DEFAULT_LIMITS, type Limits } from "@workspace/pipeline"
import type { Storage } from "@workspace/storage"
import { createLogger } from "@workspace/log"

import { publishImportEvent } from "./events"
import { failImport, completeIntake } from "./imports"
import type { StagePlanner } from "./stages"
import type { JobContext, JobHandler } from "./handlers"
import { IntakeError } from "./intake/errors"
import { parseCsvStream, type SheetRowEvent } from "./intake/csv"
import { parseXlsxFile } from "./intake/xlsx"
import { extractPhotoArchive, contentTypeForPhoto } from "./intake/zip"
import {
  downloadObject,
  downloadToTempFile,
  hashStream,
  uploadStream,
} from "./storage"

const log = createLogger({ service: "worker:intake" })

const ROW_BATCH_SIZE = 500

export interface IntakeDeps {
  storage: Storage
  cache: Cache
  /** Overrides on top of {@link DEFAULT_LIMITS}; tests tighten caps with this. */
  limits?: Partial<Limits>
  /**
   * Planner for the Stage that follows intake (ADR-0002 plan-then-execute):
   * called inside the completion transaction that advances the Import, so
   * the next Stage's Jobs exist the moment the stage value flips. Intake
   * stays stage-agnostic — the entrypoint wires the seam.
   */
  planNextStage?: StagePlanner
}

interface ImportRecord {
  id: string
  storeId: string
  sheetObjectKey: string
  sheetFormat: string
  status: string
}

async function loadImport(
  db: Database,
  importId: string
): Promise<ImportRecord | null> {
  const rows = await db
    .select({
      id: imports.id,
      storeId: imports.storeId,
      sheetObjectKey: imports.sheetObjectKey,
      sheetFormat: imports.sheetFormat,
      status: imports.status,
    })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)
  return rows[0] ?? null
}

/** Land parsed rows in batches; idempotent via the (import, row_index) key. */
async function landRows(
  db: Database,
  importId: string,
  storeId: string,
  batch: Array<{
    cells: import("@workspace/db/schema").SheetCell[]
    index: number
  }>
): Promise<void> {
  if (batch.length === 0) return
  await db
    .insert(sheetRows)
    .values(
      batch.map((row) => ({
        storeId,
        importId,
        rowIndex: row.index,
        raw: row.cells,
      }))
    )
    .onConflictDoNothing()
}

async function* sheetRowEvents(
  deps: IntakeDeps,
  imp: ImportRecord,
  limits: Limits
): AsyncGenerator<SheetRowEvent, void, void> {
  if (imp.sheetFormat === "xlsx") {
    const download = await downloadToTempFile(deps.storage, imp.sheetObjectKey)
    try {
      yield* parseXlsxFile(download.filePath, limits)
    } finally {
      await rm(download.dir, { recursive: true, force: true })
    }
    return
  }
  const body = await downloadObject(deps.storage, imp.sheetObjectKey)
  yield* parseCsvStream(body)
}

/** Hash loose photos uploaded beside the sheet (spec: hashing in the Worker). */
async function hashLoosePhotos(
  deps: IntakeDeps,
  db: Database,
  imp: ImportRecord
): Promise<void> {
  const pending = await db
    .select({
      id: importFiles.id,
      objectKey: importFiles.objectKey,
    })
    .from(importFiles)
    .where(
      and(
        eq(importFiles.importId, imp.id),
        eq(importFiles.kind, "photo"),
        isNull(importFiles.sha256)
      )
    )
  for (const photo of pending) {
    const body = await downloadObject(deps.storage, photo.objectKey)
    const sha256 = await hashStream(body)
    await db
      .update(importFiles)
      .set({ sha256 })
      .where(eq(importFiles.id, photo.id))
  }
}

/** Extract archives: validate, hash entries, re-upload them keyed by sha256. */
async function extractArchives(
  deps: IntakeDeps,
  db: Database,
  imp: ImportRecord,
  limits: Limits
): Promise<void> {
  const archives = await db
    .select({
      id: importFiles.id,
      objectKey: importFiles.objectKey,
      filename: importFiles.filename,
    })
    .from(importFiles)
    .where(
      and(eq(importFiles.importId, imp.id), eq(importFiles.kind, "photo_zip"))
    )

  for (const archive of archives) {
    const download = await downloadToTempFile(deps.storage, archive.objectKey)
    try {
      await extractPhotoArchive(download.filePath, limits, async (entry) => {
        // Pass 1: hash. Pass 2: re-upload keyed by the hash — re-running
        // intake converges on the same keys instead of duplicating objects.
        const first = await entry.open()
        const sha256 = await hashStream(first)
        const objectKey = `imports/${imp.storeId}/${imp.id}/photos/${sha256}${extensionOf(entry.name)}`
        const second = await entry.open()
        await uploadStream(
          deps.storage,
          objectKey,
          second,
          contentTypeForPhoto(entry.name)
        )
        await db
          .insert(importFiles)
          .values({
            storeId: imp.storeId,
            importId: imp.id,
            kind: "photo",
            objectKey,
            filename: entry.name,
            contentType: contentTypeForPhoto(entry.name),
            sizeBytes: entry.size,
            sha256,
          })
          .onConflictDoNothing()
      })
    } finally {
      await rm(download.dir, { recursive: true, force: true })
    }
  }
}

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".")
  return index === -1 ? "" : filename.slice(index).toLowerCase()
}

export function createIntakeHandler(deps: IntakeDeps): JobHandler {
  const limits: Limits = { ...DEFAULT_LIMITS, ...stripUndefined(deps.limits) }

  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx
    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `intake: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op

    try {
      // 1. Sheet: parse and land raw rows exactly as sent.
      let header: string[] | null = null
      let rowCount = 0
      let batch: Array<{ cells: SheetCell[]; index: number }> = []
      for await (const event of sheetRowEvents(deps, imp, limits)) {
        if (event.kind === "header") {
          header = event.cells
          continue
        }
        rowCount++
        if (rowCount > limits.maxSheetRows) {
          throw new IntakeError(
            `The sheet has more than ${limits.maxSheetRows.toLocaleString("en-US")} rows — split it into smaller sheets or contact support to raise the limit.`,
            { ec: "EC-008" }
          )
        }
        batch.push({ cells: event.cells, index: rowCount })
        if (batch.length >= ROW_BATCH_SIZE) {
          await landRows(db, imp.id, imp.storeId, batch)
          batch = []
        }
      }
      await landRows(db, imp.id, imp.storeId, batch)

      if (header === null) {
        throw new IntakeError(
          "The sheet is empty (0 bytes) — export it again and upload the new file.",
          { ec: "EC-006" }
        )
      }
      if (rowCount === 0) {
        throw new IntakeError(
          "The sheet has no data rows — only a header row was found. Check the export includes your data.",
          { ec: "EC-011" }
        )
      }

      // 2. Photos: hash loose uploads, extract and hash archive entries.
      //    BEFORE the stage advances (Parked-Photo guarantee): once the
      //    Import's stage leaves `intake`, the media stage may run — any
      //    photo not yet hashed/extracted here could neither match a Product
      //    nor park. Both steps are idempotent, so a requeued intake (e.g.
      //    crash mid-extraction) converges: loose photos hash only when
      //    `sha256` is null, archive entries upsert conflict-nothing.
      await hashLoosePhotos(deps, db, imp)
      await extractArchives(deps, db, imp, limits)

      // 3. Advance the Stage machinery (idempotent guard: only the run that
      //    finds stage='intake' advances and publishes).
      const advancedTo = await completeIntake(
        db,
        imp.id,
        header,
        rowCount,
        deps.planNextStage
      )
      if (advancedTo) {
        await publishImportEvent(deps.cache, {
          importId: imp.id,
          type: "stage_changed",
          data: { importId: imp.id, from: "intake", to: advancedTo },
        })
      }

      log.info(`intake completed`, {
        importId: imp.id,
        jobId: job.id,
        rowCount,
      })
    } catch (error) {
      if (error instanceof IntakeError) {
        await failImport(db, imp.id, error.message)
        await publishImportEvent(deps.cache, {
          importId: imp.id,
          type: "import_done",
          data: { importId: imp.id, status: "failed", reason: error.message },
        })
        log.error(`intake failed the import`, {
          importId: imp.id,
          jobId: job.id,
          reason: error.message,
          ec: error.ec,
        })
        return
      }
      throw error
    }
  }
}

function stripUndefined<T extends object>(value?: T): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>
}
