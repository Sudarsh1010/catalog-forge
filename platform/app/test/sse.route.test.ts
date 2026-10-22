/**
 * SSE endpoint — plain HTTP against a real `next dev`: snapshot first, then
 * the capped Redis stream; reconnect with Last-Event-ID resumes without
 * gaps. Stream entries published while the connection is open are seeded
 * through Redis directly (the Event Stream is a fact source, not worker
 * internals).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { createIntakeHandler, createWorker } from "@workspace/worker"
import { importStreamKey } from "@workspace/pipeline"

import {
  blob,
  connectTestDb,
  createTestDatabase,
  csvBytes,
  dropTestDatabase,
  flushTestRedis,
  startTestApp,
  testCache,
  testStorage,
  truncateTables,
  waitFor,
  type TestApp,
} from "./helpers"

let app: TestApp
let db: Db
let storage: Storage
let cache: Cache

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  storage = testStorage()
  cache = testCache()
  await flushTestRedis()
  app = await startTestApp()
})

beforeEach(async () => {
  await truncateTables(db)
})

afterAll(async () => {
  await app.close()
  await db.close()
  await flushTestRedis()
  await dropTestDatabase()
})

interface SseEvent {
  id?: string
  event: string
  data: string
}

/** Read SSE frames off a fetch response until `count` events collected. */
async function readSseEvents(
  response: Response,
  count: number,
  timeoutMs = 15_000
): Promise<{
  events: SseEvent[]
  reader: ReadableStreamDefaultReader<Uint8Array>
}> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events: SseEvent[] = []
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out reading SSE events")
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary = buffer.indexOf("\n\n")
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed: SseEvent = { event: "message", data: "" }
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) parsed.id = line.slice(4)
        else if (line.startsWith("event: ")) parsed.event = line.slice(7)
        else if (line.startsWith("data: ")) parsed.data += line.slice(6)
      }
      if (parsed.data !== "" || parsed.event !== "message") {
        events.push(parsed)
      }
      boundary = buffer.indexOf("\n\n")
    }
    if (events.length >= count) {
      // Leave the connection open for the caller; they own the reader now.
      return { events, reader }
    }
  }
  return { events, reader }
}

/** Upload one sheet and run intake in-process until it advances. */
async function uploadAndIntake(): Promise<string> {
  const form = new FormData()
  form.append(
    "sheet",
    blob(csvBytes([["sku"], ["TP-100"]]), "text/csv"),
    "sheet.csv"
  )
  const response = await fetch(`${app.baseUrl}/api/imports`, {
    method: "POST",
    body: form,
  })
  expect(response.status).toBe(201)
  const payload = (await response.json()) as { import: { id: string } }
  const importId = payload.import.id

  const handler = createIntakeHandler({ storage, cache })
  const worker = createWorker({
    db,
    handlers: { intake: handler },
    cache,
    config: {
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      heartbeatIntervalMs: 100,
      leaseTtlMs: 5_000,
      batchSize: 5,
    },
  })
  worker.start()
  try {
    await waitFor("import advanced to clean", async () => {
      const detail = await fetch(`${app.baseUrl}/api/imports/${importId}`)
      const body = (await detail.json()) as { import: { stage: string } }
      return body.import.stage === "clean"
    })
  } finally {
    await worker.stop()
  }
  return importId
}

describe("GET /api/imports/[id]/events", () => {
  it("sends the Postgres snapshot first, then replays the stream", async () => {
    const importId = await uploadAndIntake()

    const response = await fetch(
      `${app.baseUrl}/api/imports/${importId}/events`,
      { headers: { accept: "text/event-stream" } }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")

    // Snapshot + the two facts intake published (stage_changed, job_completed).
    const { events } = await readSseEvents(response, 3)
    expect(events[0]!.event).toBe("snapshot")
    const snapshot = JSON.parse(events[0]!.data) as {
      id: string
      stage: string
    }
    expect(snapshot.id).toBe(importId)
    expect(snapshot.stage).toBe("clean")
    const replayed = events.slice(1).map((e) => e.event)
    expect(replayed).toContain("stage_changed")
    expect(replayed).toContain("job_completed")
    expect(
      events.every((e) => typeof e.id === "string" || e.event === "snapshot")
    ).toBe(true)
  })

  it("delivers events published while the connection is open", async () => {
    const importId = await uploadAndIntake()
    const response = await fetch(
      `${app.baseUrl}/api/imports/${importId}/events`
    )
    const { events: first, reader } = await readSseEvents(response, 3)

    await cache.redis.xadd(
      importStreamKey(importId),
      "*",
      "type",
      "row_failed",
      "data",
      JSON.stringify({
        type: "row_failed",
        at: new Date().toISOString(),
        data: { importId, rowIndex: 1 },
      })
    )
    // One more frame: the freshly published event.
    const decoder = new TextDecoder()
    let buffer = ""
    const deadline = Date.now() + 15_000
    for (;;) {
      if (Date.now() > deadline) throw new Error("live event never arrived")
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.includes("event: row_failed")) break
    }
    expect(buffer).toContain("row_failed")
    expect(first.length).toBeGreaterThan(0)
    void reader.cancel().catch(() => {})
  })

  it("reconnects from Last-Event-ID without gaps or duplicates", async () => {
    const importId = await uploadAndIntake()

    // First connection: snapshot + the two intake facts.
    const first = await fetch(`${app.baseUrl}/api/imports/${importId}/events`)
    const { events: initial, reader: firstReader } = await readSseEvents(
      first,
      3
    )
    const lastSeenId = initial[initial.length - 1]!.id!
    expect(lastSeenId).not.toBe("")

    void firstReader.cancel().catch(() => {})

    // A new fact lands while disconnected.
    await cache.redis.xadd(
      importStreamKey(importId),
      "*",
      "type",
      "paused",
      "data",
      JSON.stringify({
        type: "paused",
        at: new Date().toISOString(),
        data: { importId, provider: "stub", resumeAt: null },
      })
    )

    // Reconnect from the last-seen ID.
    const resumed = await fetch(
      `${app.baseUrl}/api/imports/${importId}/events`,
      {
        headers: { "last-event-id": lastSeenId },
      }
    )
    const { events } = await readSseEvents(resumed, 2)
    expect(events[0]!.event).toBe("snapshot")
    expect(events[1]!.event).toBe("paused")
    expect(events[1]!.id! > lastSeenId).toBe(true)
    const streamedIds = events.slice(1).map((e) => e.id)
    expect(streamedIds).not.toContain(lastSeenId)
  })

  it("returns 404 for an unknown import", async () => {
    const response = await fetch(
      `${app.baseUrl}/api/imports/${crypto.randomUUID()}/events`
    )
    expect(response.status).toBe(404)
  })
})
