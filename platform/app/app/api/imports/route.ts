/**
 * Upload → acknowledgment. Streams the multipart request (sheet + photos +
 * optional photos ZIP) straight into object storage with only cheap
 * validation (extension, declared size, content type) and returns as soon
 * as the files are stored and the Import row exists — the Sweeper does the
 * rest (ADR-0004). ZIP extraction, entry validation and photo hashing are
 * worker `intake` concerns, never web-request concerns.
 *
 * Re-uploading identical sheet content targets the same Import and is a
 * no-op (unique (store_id, content_hash) + ON CONFLICT DO NOTHING, EC-009).
 */
import { Readable } from "node:stream"

import { DeleteObjectCommand } from "@aws-sdk/client-s3"
import { and, desc, eq } from "drizzle-orm"
import busboy from "busboy"

import type { Database } from "@workspace/db"
import type { Import, NewImportFile } from "@workspace/db/schema"
import { importFiles, imports } from "@workspace/db/schema"
import type { Storage } from "@workspace/storage"
import { DEFAULT_STORE_ID } from "@workspace/pipeline"

import { getDb } from "@/lib/db"
import { toImportDto } from "@/lib/imports"
import { megabytes, readUploadLimits } from "@/lib/limits"
import { getStorage } from "@/lib/storage"
import {
  classifyPart,
  hasExtension,
  hashAndCapStream,
  rejectWrongType,
  safeFilename,
  streamToStorage,
  UploadRejected,
} from "@/lib/upload"

export const runtime = "nodejs"

function errorResponse(
  message: string,
  status: number,
  code: string
): Response {
  return Response.json({ error: { message, code } }, { status })
}

interface UploadedFile {
  kind: "sheet" | "photo" | "archive"
  objectKey: string
  filename: string
  contentType?: string
  sizeBytes: number
  sha256?: string
}

/** Best-effort cleanup: an aborted or failed upload leaves no objects behind. */
async function deleteObjects(storage: Storage, keys: string[]): Promise<void> {
  await Promise.allSettled(
    keys.map((key) =>
      storage.client.send(
        new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })
      )
    )
  )
}

export async function POST(request: Request): Promise<Response> {
  const limits = readUploadLimits()
  const storeId = DEFAULT_STORE_ID
  const storage = getStorage()
  const db = getDb().db

  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.startsWith("multipart/form-data")) {
    return errorResponse(
      "Send the upload as multipart/form-data with a `sheet` field (CSV or XLSX), optional `photos` files and an optional `zip` archive.",
      400,
      "expected_multipart"
    )
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0")
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > limits.maxRequestBytes
  ) {
    return errorResponse(
      `This upload declares ${megabytes(declaredLength)} — the limit is ${megabytes(limits.maxRequestBytes)} per upload. Split the photos into several uploads.`,
      413,
      "request_too_large"
    )
  }

  const uploadId = crypto.randomUUID()
  const uploadedKeys: string[] = []
  const files: UploadedFile[] = []
  let sheetDedupeHit: Import | null = null
  let aborted = false
  let pendingError: UploadRejected | Error | null = null

  const bb = busboy({
    headers: {
      "content-type": contentType,
      ...(Number.isFinite(declaredLength)
        ? { "content-length": String(declaredLength) }
        : {}),
    },
    limits: { files: 20, fileSize: Infinity },
  })

  const finished = new Promise<void>((resolve, reject) => {
    bb.on("error", reject)
    bb.on("close", resolve)
  })
  /** Per-part storage pipelines; busboy `close` does not wait for these. */
  const partUploads: Promise<void>[] = []

  bb.on("file", (fieldname, fileStream, info) => {
    if (aborted) {
      fileStream.resume()
      return
    }
    const classification = classifyPart(fieldname, limits)
    if (!classification) {
      pendingError = new UploadRejected(
        `Unexpected file field "${fieldname}". Use \`sheet\` for the CSV/XLSX, \`photos\` for images and \`zip\` for a photo archive.`,
        { status: 400, code: "unexpected_field" }
      )
      aborted = true
      fileStream.resume()
      request.body?.cancel().catch(() => {})
      return
    }
    // busboy types filenames as possibly-undefined; a missing name is still
    // uploadable but must pass extension validation.
    const filename = info.filename ?? "upload"
    if (!hasExtension(filename, classification.acceptedExtensions)) {
      pendingError = rejectWrongType(classification, filename)
      aborted = true
      fileStream.resume()
      request.body?.cancel().catch(() => {})
      return
    }
    if (
      classification.kind === "sheet" &&
      files.some((f) => f.kind === "sheet")
    ) {
      pendingError = new UploadRejected(
        "Upload one sheet per import — pick the CSV or XLSX you want to import.",
        { status: 400, code: "multiple_sheets" }
      )
      aborted = true
      fileStream.resume()
      request.body?.cancel().catch(() => {})
      return
    }

    const objectKey = `imports/${storeId}/${uploadId}/${classification.segment}/${files.length}-${safeFilename(filename)}`
    uploadedKeys.push(objectKey)
    const metered = hashAndCapStream(classification.limitBytes, filename)
    fileStream.pipe(metered)

    const done = streamToStorage(
      storage,
      objectKey,
      metered,
      info.mimeType || undefined
    )
      .then(() => {
        if (aborted) return
        const sheetSha256 =
          classification.kind === "sheet" ? metered.sha256() : undefined
        files.push({
          kind: classification.kind,
          objectKey,
          filename,
          contentType: info.mimeType || undefined,
          sizeBytes: metered.byteCount(),
          sha256: sheetSha256,
        })
        if (classification.kind === "sheet" && metered.byteCount() === 0) {
          pendingError = new UploadRejected(
            "The sheet file is empty (0 bytes) — export it again and upload the new file.",
            { status: 400, code: "empty_file" }
          )
          aborted = true
          request.body?.cancel().catch(() => {})
          return
        }
        if (sheetSha256) {
          // Dedupe as soon as the sheet's hash is known: identical content
          // targets the same Import and skips the rest of the upload.
          void findExistingImport(db, storeId, sheetSha256).then((existing) => {
            if (!existing) return
            sheetDedupeHit = existing
            aborted = true
            request.body?.cancel().catch(() => {})
          })
        }
      })
      .catch((error: unknown) => {
        if (!pendingError) pendingError = error as Error
        aborted = true
        request.body?.cancel().catch(() => {})
      })
    partUploads.push(done)
  })

  async function run(): Promise<Response> {
    try {
      Readable.fromWeb(request.body as never).pipe(bb)
      await finished
      await Promise.all(partUploads)
    } catch (error) {
      pendingError ??= error as Error
    }
    if (sheetDedupeHit) {
      void deleteObjects(storage, uploadedKeys)
      return Response.json(
        { import: toImportDto(sheetDedupeHit), deduped: true },
        { status: 200 }
      )
    }
    if (pendingError) {
      void deleteObjects(storage, uploadedKeys)
      if (pendingError instanceof UploadRejected) {
        return errorResponse(
          pendingError.message,
          pendingError.status,
          pendingError.code
        )
      }
      console.error("upload failed", pendingError)
      return errorResponse(
        "The upload could not be stored — please try again in a moment.",
        502,
        "storage_unavailable"
      )
    }
    const sheet = files.find((f) => f.kind === "sheet")
    if (!sheet || !sheet.sha256) {
      void deleteObjects(storage, uploadedKeys)
      return errorResponse(
        "Add a supplier sheet to upload — a CSV or XLSX file in the `sheet` field.",
        400,
        "missing_sheet"
      )
    }

    // One transaction: the Import and its file records appear together, so
    // the Sweeper never adopts an Import whose files are missing (EC-013).
    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(imports)
        .values({
          storeId,
          contentHash: sheet.sha256!,
          originalFilename: safeFilename(sheet.filename),
          sheetFormat: sheet.filename.toLowerCase().endsWith(".xlsx")
            ? "xlsx"
            : "csv",
          sheetObjectKey: sheet.objectKey,
          status: "queued",
          stage: "intake",
        })
        .onConflictDoNothing()
        .returning()
      if (inserted.length === 0) return null // raced an identical upload
      const rows: NewImportFile[] = files.map((file) => ({
        storeId,
        importId: inserted[0]!.id,
        kind:
          file.kind === "sheet"
            ? ("sheet" as const)
            : file.kind === "photo"
              ? ("photo" as const)
              : ("photo_zip" as const),
        objectKey: file.objectKey,
        filename: safeFilename(file.filename),
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      }))
      await tx.insert(importFiles).values(rows)
      return inserted[0]!
    })

    if (!created) {
      const existing = await findExistingImport(db, storeId, sheet.sha256)
      void deleteObjects(storage, uploadedKeys)
      if (existing) {
        return Response.json(
          { import: toImportDto(existing), deduped: true },
          { status: 200 }
        )
      }
      return errorResponse(
        "This sheet is already being imported.",
        409,
        "duplicate_in_flight"
      )
    }

    return Response.json(
      { import: toImportDto(created), deduped: false },
      { status: 201 }
    )
  }

  return run()
}

async function findExistingImport(
  db: Database,
  storeId: string,
  contentHash: string
): Promise<Import | null> {
  const rows = await db
    .select()
    .from(imports)
    .where(
      and(eq(imports.storeId, storeId), eq(imports.contentHash, contentHash))
    )
    .limit(1)
  return rows[0] ?? null
}

/** The import queue, newest first (the dashboard's initial hydration). */
export async function GET(): Promise<Response> {
  const db = getDb().db
  const rows = await db
    .select()
    .from(imports)
    .orderBy(desc(imports.createdAt))
    .limit(100)
  return Response.json({ imports: rows.map(toImportDto) })
}
