/**
 * Publisher for the per-Import Event Stream (GLOSSARY: Event Stream) — the
 * lossy Redis progress feed the dashboard tails over SSE (ADR-0001). Postgres
 * stays the source of truth; dropping an entry may only ever cost the UI a
 * refresh, never a fact.
 *
 * Each XADD caps the stream (MAXLEN ~) so a 10k-row Import can't grow it
 * without bound.
 */
import type { Cache } from "@workspace/cache"
import {
  importStreamKey,
  STREAM_MAX_ENTRIES,
  type ImportEvent,
  type ImportEventType,
} from "@workspace/pipeline"

export interface PublishImportEventOptions {
  importId: string
  type: ImportEventType
  data: Record<string, unknown>
}

/** Append one progress fact to the Import's stream, trimming the tail. */
export async function publishImportEvent(
  cache: Cache,
  options: PublishImportEventOptions
): Promise<void> {
  const event: ImportEvent = {
    type: options.type,
    at: new Date().toISOString(),
    data: options.data,
  }
  await cache.redis.xadd(
    importStreamKey(options.importId),
    "MAXLEN",
    "~",
    STREAM_MAX_ENTRIES,
    "*",
    "type",
    options.type,
    "data",
    JSON.stringify(event)
  )
}
