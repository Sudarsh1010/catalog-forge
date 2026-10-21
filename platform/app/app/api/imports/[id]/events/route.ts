/**
 * Per-Import SSE progress feed (spec: Events). Semantics:
 *
 *   1. A Postgres SNAPSHOT first — the authoritative state (ADR-0001: the
 *      stream is lossy, so the snapshot is what makes drops harmless).
 *   2. Then the import's capped Redis stream, tailed from the client's
 *      Last-Event-ID when reconnecting (no gaps), from the beginning of the
 *      retained window otherwise.
 *
 * Each stream entry becomes an SSE event carrying the Redis entry ID, so
 * EventSource reconnects resume exactly where the client left off.
 */
import { eq } from "drizzle-orm"

import { createCache, type Cache } from "@workspace/cache"
import { CACHE_KEY_PREFIX, importStreamKey } from "@workspace/pipeline"

import { imports } from "@workspace/db/schema"

import { requireEnv } from "@/lib/env"
import { getDb } from "@/lib/db"
import { toImportDto } from "@/lib/imports"

export const runtime = "nodejs"

const BLOCK_MS = 15_000

interface StreamEntry {
  id: string
  type: string
  data: string
}

function parseEntries(result: unknown): StreamEntry[] {
  const entries: StreamEntry[] = []
  for (const [, perStream] of (result ?? []) as Array<
    [string, Array<[string, string[]]>]
  >) {
    for (const [id, fields] of perStream) {
      const flat = new Map<string, string>()
      for (let i = 0; i < fields.length; i += 2) {
        flat.set(fields[i]!, fields[i + 1]!)
      }
      entries.push({
        id,
        type: flat.get("type") ?? "unknown",
        data: flat.get("data") ?? "{}",
      })
    }
  }
  return entries
}

function sseChunk(chunk: {
  id?: string
  event?: string
  data: string
}): string {
  let out = ""
  if (chunk.id) out += `id: ${chunk.id}\n`
  if (chunk.event) out += `event: ${chunk.event}\n`
  out += `data: ${chunk.data}\n\n`
  return out
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const db = getDb().db
  const rows = await db
    .select()
    .from(imports)
    .where(eq(imports.id, id))
    .limit(1)
  if (rows.length === 0) {
    return Response.json(
      { error: { code: "not_found", message: "Import not found." } },
      { status: 404 }
    )
  }
  const lastEventId =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("lastEventId") ??
    "0"

  // One dedicated Redis connection per SSE client: XREAD BLOCK holds the
  // connection for the life of the stream, and maxRetriesPerRequest must be
  // null for blocking commands.
  const redis: Cache = createCache({
    url: requireEnv("REDIS_URL"),
    keyPrefix: CACHE_KEY_PREFIX,
    maxRetriesPerRequest: null,
  })
  const streamKey = importStreamKey(id)
  const encoder = new TextEncoder()

  let closed = false
  const abort = (): void => {
    closed = true
    redis.redis.disconnect()
  }
  request.signal.addEventListener("abort", abort)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: {
        id?: string
        event?: string
        data: string
      }): void => {
        if (closed) return
        controller.enqueue(encoder.encode(sseChunk(chunk)))
      }
      try {
        // 1. Snapshot from Postgres — the state of record.
        send({ event: "snapshot", data: JSON.stringify(toImportDto(rows[0]!)) })

        // 2. Tail the capped stream from the last-seen ID.
        let cursor = lastEventId
        while (!closed && !request.signal.aborted) {
          const result = await redis.redis.xread(
            "BLOCK",
            BLOCK_MS,
            "STREAMS",
            streamKey,
            cursor
          )
          if (closed) break
          const entries = parseEntries(result)
          if (entries.length === 0) {
            // Comment line: keeps proxies from closing an idle stream.
            controller.enqueue(encoder.encode(": keep-alive\n\n"))
            continue
          }
          for (const entry of entries) {
            cursor = entry.id
            send({
              id: entry.id,
              event: entry.type,
              data: entry.data,
            })
          }
        }
      } catch {
        // Connection closed (client abort or redis shutdown) — fall through.
      } finally {
        request.signal.removeEventListener("abort", abort)
        redis.redis.disconnect()
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      abort()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
