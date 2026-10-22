/**
 * Upload limits for the web request. Defaults come from
 * @workspace/pipeline so the app's cheap validation can never drift from
 * the worker's real enforcement; the deployment may tighten or raise them
 * via environment.
 */
import { DEFAULT_LIMITS, type Limits } from "@workspace/pipeline"

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function readUploadLimits(): Limits {
  return {
    maxSheetBytes: intFromEnv("MAX_SHEET_BYTES", DEFAULT_LIMITS.maxSheetBytes),
    maxPhotoBytes: intFromEnv("MAX_PHOTO_BYTES", DEFAULT_LIMITS.maxPhotoBytes),
    maxPhotosZipBytes: intFromEnv(
      "MAX_PHOTOS_ZIP_BYTES",
      DEFAULT_LIMITS.maxPhotosZipBytes
    ),
    maxRequestBytes: intFromEnv(
      "MAX_REQUEST_BYTES",
      DEFAULT_LIMITS.maxRequestBytes
    ),
    maxSheetRows: DEFAULT_LIMITS.maxSheetRows,
    maxZipEntries: DEFAULT_LIMITS.maxZipEntries,
    maxZipEntryBytes: DEFAULT_LIMITS.maxZipEntryBytes,
    maxZipTotalUncompressedBytes: DEFAULT_LIMITS.maxZipTotalUncompressedBytes,
  }
}

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}
