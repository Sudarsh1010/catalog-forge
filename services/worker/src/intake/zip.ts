/**
 * Photo-archive extraction (worker-only by design: ZIP extraction, entry-name
 * validation and decompression caps never run in the web request).
 *
 * Guards (EC-006/EC-008): path-traversal entry names are rejected before any
 * byte is read; entry count, per-entry and total decompressed sizes are
 * capped against the central directory; entry sizes are validated against
 * the directory while streaming (zip-bomb lying about its sizes fails).
 */
import { type Readable } from "node:stream"
import path from "node:path"

import yauzl from "yauzl"

import type { Limits } from "@workspace/pipeline"

import { IntakeError } from "./errors"
import { openZip, closeZip, openEntryStream } from "./xlsx"

/** Extensions we treat as photos; anything else in the archive is skipped. */
const PHOTO_EXTENSIONS: Record<string, true> = {
  ".jpg": true,
  ".jpeg": true,
  ".png": true,
  ".webp": true,
  ".gif": true,
  ".avif": true,
  ".heic": true,
  ".heif": true,
  ".tif": true,
  ".tiff": true,
  ".bmp": true,
}

export function isPhotoFilename(filename: string): boolean {
  const extension = path.extname(filename).toLowerCase()
  return extension in PHOTO_EXTENSIONS
}

export function contentTypeForPhoto(filename: string): string {
  const extension = path.extname(filename).toLowerCase()
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    case ".webp":
      return "image/webp"
    case ".gif":
      return "image/gif"
    case ".avif":
      return "image/avif"
    case ".heic":
      return "image/heic"
    case ".heif":
      return "image/heif"
    case ".tif":
    case ".tiff":
      return "image/tiff"
    case ".bmp":
      return "image/bmp"
    default:
      return "application/octet-stream"
  }
}

/**
 * Validate one archive entry name (EC-006): no absolute paths, no `..`
 * segments, no drive letters, no NUL — entries are only ever read as bytes,
 * but the validation is what keeps a hostile archive obviously hostile.
 */
export function assertSafeEntryName(name: string): void {
  if (name.includes("\0")) {
    throw new IntakeError(
      `The photo archive contains an entry with an unsafe name ("${truncateName(name)}") and was rejected.`,
      { ec: "EC-006" }
    )
  }
  const normalized = name.replaceAll("\\", "/")
  if (normalized.startsWith("/")) {
    throw new IntakeError(
      `The photo archive contains an entry with an absolute path ("${truncateName(name)}") and was rejected.`,
      { ec: "EC-006" }
    )
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new IntakeError(
      `The photo archive contains an entry with a drive-letter path ("${truncateName(name)}") and was rejected.`,
      { ec: "EC-006" }
    )
  }
  const segments = normalized.split("/")
  if (segments.includes("..")) {
    throw new IntakeError(
      `The photo archive contains an entry escaping its folder ("${truncateName(name)}") — path traversal is not allowed.`,
      { ec: "EC-006" }
    )
  }
}

function truncateName(name: string): string {
  return name.length > 80 ? `${name.slice(0, 77)}…` : name
}

export interface ArchivePhotoEntry {
  /** Entry path inside the archive, as the supplier packed it. */
  name: string
  /** Declared uncompressed size from the central directory. */
  size: number
  /** The entry's bytes; each call re-opens a fresh stream. */
  open(): Promise<Readable>
}

/**
 * Validate the archive's central directory and hand photo entries to
 * `onEntry` (streamed; call `entry.open()` as many times as needed — hashing
 * and re-upload use two passes). Validation failures throw IntakeError.
 */
export async function extractPhotoArchive(
  filePath: string,
  limits: Limits,
  onEntry: (entry: ArchivePhotoEntry) => Promise<void>
): Promise<void> {
  const handle = await openZip(filePath, {
    what: "photo archive (ZIP)",
  })
  const run = async (): Promise<void> => {
    const entries = handle.entries.filter(
      (entry) =>
        !entry.fileName.endsWith("/") &&
        !entry.fileName.startsWith("__MACOSX/") &&
        path.posix.basename(entry.fileName) !== ".DS_Store"
    )

    if (entries.length > limits.maxZipEntries) {
      throw new IntakeError(
        `The photo archive contains ${entries.length.toLocaleString("en-US")} entries — more than the limit of ${limits.maxZipEntries.toLocaleString("en-US")}. Split it into smaller archives.`,
        { ec: "EC-008" }
      )
    }
    const totalUncompressed = entries.reduce(
      (sum, entry) => sum + entry.uncompressedSize,
      0
    )
    if (totalUncompressed > limits.maxZipTotalUncompressedBytes) {
      throw new IntakeError(
        `The photo archive decompresses to ${(totalUncompressed / (1024 * 1024)).toFixed(0)} MB — over the limit of ${(limits.maxZipTotalUncompressedBytes / (1024 * 1024)).toFixed(0)} MB. Split it into smaller archives.`,
        { ec: "EC-008" }
      )
    }

    const photos = entries.filter(
      (entry) => isPhotoFilename(entry.fileName) && entry.uncompressedSize > 0
    )

    for (const entry of photos) {
      assertSafeEntryName(entry.fileName)
      if (entry.uncompressedSize > limits.maxZipEntryBytes) {
        throw new IntakeError(
          `Archive entry "${truncateName(entry.fileName)}" is ${(entry.uncompressedSize / (1024 * 1024)).toFixed(1)} MB — larger than the per-file limit of ${(limits.maxZipEntryBytes / (1024 * 1024)).toFixed(0)} MB.`,
          { ec: "EC-008" }
        )
      }
      await onEntry({
        name: entry.fileName,
        size: entry.uncompressedSize,
        open: async () => {
          const stream = await openEntryStream(handle, entry)
          return stream
        },
      })
    }
  }
  try {
    // yauzl validates entry sizes while streaming; a mismatch surfaces as a
    // zipfile 'error' after openZip resolved — race it against the work.
    await Promise.race([run(), handle.failure])
  } finally {
    closeZip(handle)
  }
}
