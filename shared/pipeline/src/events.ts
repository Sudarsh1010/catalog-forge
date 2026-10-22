/**
 * The per-Import Event Stream vocabulary (GLOSSARY: Event Stream).
 *
 * One capped Redis Stream per Import carries lossy progress facts for the
 * dashboard (ADR-0001): Postgres stays the source of truth, SSE rebuilds
 * from a snapshot and tails this stream from its last-seen ID.
 */

/** Event names, straight from the spec's "Events" decision. */
export const IMPORT_EVENT_TYPES = [
  "stage_changed",
  "job_completed",
  "row_failed",
  "paused",
  "import_done",
] as const

export type ImportEventType = (typeof IMPORT_EVENT_TYPES)[number]

/** One progress fact as it travels: Redis field → SSE event → browser. */
export interface ImportEvent<TData = unknown> {
  type: ImportEventType
  /** ISO-8601 timestamp of when the worker observed the fact. */
  at: string
  data: TData
}

/** Events are capped: XADD trims the stream to roughly this many entries. */
export const STREAM_MAX_ENTRIES = 1_000

/** ioredis keyPrefix shared by the app and the worker so stream keys line up. */
export const CACHE_KEY_PREFIX = "catalog-forge:"

/** The Redis Stream key carrying one Import's progress facts. */
export function importStreamKey(importId: string): string {
  return `import:${importId}:events`
}
