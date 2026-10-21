/**
 * The upload pipeline: stream a multipart request straight into object
 * storage with only cheap validation (extension, declared size, content
 * type) — no buffering, no ZIP extraction, no hashing of photos. The sheet's
 * sha256 is computed while streaming because it is the Import's identity
 * (content-hash dedupe). Everything structural happens later, in worker
 * `intake`.
 */
import { createHash } from "node:crypto"
import { type Readable, Transform } from "node:stream"

import { Upload } from "@aws-sdk/lib-storage"
import busboy from "busboy"

import type { Limits } from "@workspace/pipeline"
import type { Storage } from "@workspace/storage"

export class UploadRejected extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, options: { status: number; code: string }) {
    super(message)
    this.name = "UploadRejected"
    this.status = options.status
    this.code = options.code
  }
}

export const SHEET_EXTENSIONS = [".csv", ".xlsx"] as const
export const PHOTO_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".avif",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".bmp",
] as const
export const ARCHIVE_EXTENSIONS = [".zip"] as const

function hasExtension(
  filename: string,
  extensions: readonly string[]
): boolean {
  const lower = filename.toLowerCase()
  return extensions.some((extension) => lower.endsWith(extension))
}

/** Strip path components and control characters from a client filename. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "upload"
  const cleaned = base.replace(/[\0-\x1f\x7f]/g, "").trim()
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "upload"
}

/**
 * Stream transform that hashes, counts bytes and enforces a per-file cap.
 * The cap aborts the stream the moment it is exceeded — a too-large file
 * never finishes uploading.
 */
export function hashAndCapStream(
  limitBytes: number,
  label: string
): Transform & { sha256: () => string; byteCount: () => number } {
  const hash = createHash("sha256")
  let bytes = 0
  const transform: Transform = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > limitBytes) {
        callback(
          new UploadRejected(
            `"${label}" is larger than the limit of ${(limitBytes / (1024 * 1024)).toFixed(0)} MB. Split it or compress photos into a ZIP.`,
            { status: 413, code: "file_too_large" }
          )
        )
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  return Object.assign(transform, {
    sha256: () => hash.digest("hex"),
    byteCount: () => bytes,
  })
}

/** Stream a web Readable to S3 through a cap/hash transform. */
export async function streamToStorage(
  storage: Storage,
  key: string,
  body: Readable,
  contentType: string | undefined
): Promise<Upload> {
  const upload = new Upload({
    client: storage.client,
    params: {
      Bucket: storage.bucket,
      Key: key,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    },
    leavePartsOnError: false,
  })
  await upload.done()
  return upload
}

export type PartKind = "sheet" | "photo" | "archive"

export interface PartClassification {
  kind: PartKind
  /** Storage key prefix segment, e.g. `photos`. */
  segment: "sheet" | "photos" | "archive"
  limitBytes: number
  acceptedExtensions: readonly string[]
  friendlyTypes: string
}

export function classifyPart(
  fieldname: string,
  limits: Limits
): PartClassification | null {
  switch (fieldname) {
    case "sheet":
      return {
        kind: "sheet",
        segment: "sheet",
        limitBytes: limits.maxSheetBytes,
        acceptedExtensions: SHEET_EXTENSIONS,
        friendlyTypes: "CSV or XLSX",
      }
    case "photos":
      return {
        kind: "photo",
        segment: "photos",
        limitBytes: limits.maxPhotoBytes,
        acceptedExtensions: PHOTO_EXTENSIONS,
        friendlyTypes: "JPG, PNG, WebP, GIF, AVIF, HEIC or TIFF images",
      }
    case "zip":
      return {
        kind: "archive",
        segment: "archive",
        limitBytes: limits.maxPhotosZipBytes,
        acceptedExtensions: ARCHIVE_EXTENSIONS,
        friendlyTypes: "a ZIP of photos",
      }
    default:
      return null
  }
}

export function rejectWrongType(
  classification: PartClassification,
  filename: string
): UploadRejected {
  return new UploadRejected(
    `"${safeFilename(filename)}" is not a supported file type for the "${classification.kind === "archive" ? "zip" : classification.kind}" field — expected ${classification.friendlyTypes}.`,
    { status: 415, code: "unsupported_type" }
  )
}

export { hasExtension }
