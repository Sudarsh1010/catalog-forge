/**
 * Upload/intake limits. Defaults live here so the web request (cheap
 * declared-size validation) and the worker `intake` Stage (real
 * enforcement) can never drift apart. Each deployable may raise or lower
 * them from its own environment.
 *
 * The defaults target the spec's scale: 100 MB sheets, 500 MB photo ZIPs,
 * 10k–500k rows (EC-008).
 */
export const DEFAULT_LIMITS = {
  /** One sheet file (CSV/XLSX). */
  maxSheetBytes: 100 * 1024 * 1024,
  /** One photo file. */
  maxPhotoBytes: 25 * 1024 * 1024,
  /** The photos ZIP archive, compressed. */
  maxPhotosZipBytes: 500 * 1024 * 1024,
  /** The whole upload request (sheet + photos + archive + multipart overhead). */
  maxRequestBytes: 620 * 1024 * 1024,
  /** Data rows per sheet. */
  maxSheetRows: 250_000,
  /** Entries inside one photos ZIP. */
  maxZipEntries: 5_000,
  /** One decompressed ZIP entry. */
  maxZipEntryBytes: 60 * 1024 * 1024,
  /** Total decompressed size of one photos ZIP. */
  maxZipTotalUncompressedBytes: 600 * 1024 * 1024,
} as const

export type Limits = {
  -readonly [K in keyof typeof DEFAULT_LIMITS]: number
}
