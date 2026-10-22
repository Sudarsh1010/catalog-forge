"use client"

/**
 * Live per-Import progress over SSE: snapshot first, then stream events.
 * EventSource reconnects automatically and resends Last-Event-ID, so a
 * dropped connection resumes without gaps; the snapshot re-syncs state.
 *
 * Stream events arrive as the worker's published envelope
 * `{ type, at, data }` — the payload fields live under `data`.
 */
import { useEffect, useRef } from "react"

import type { ImportDto } from "@/lib/imports"

interface ImportEventEnvelope {
  type?: string
  at?: string
  data?: {
    importId?: string
    from?: string
    to?: string
    status?: string
    reason?: string
    providerId?: string
    resumeAt?: string | null
  }
}

type Listener = (patch: Partial<ImportDto>) => void

/**
 * Subscribe to one import's event stream. The listener receives patches
 * derived from SSE events; the initial snapshot patches the full state
 * (the detail read model, whose extra fields flow through to the caller).
 */
export function useImportEvents(
  importId: string | undefined,
  listener: Listener
): void {
  const listenerRef = useRef<Listener>(listener)

  useEffect(() => {
    listenerRef.current = listener
  })

  useEffect(() => {
    if (!importId) return
    const source = new EventSource(`/api/imports/${importId}/events`)

    const applyEnvelope = (raw: string): void => {
      let envelope: ImportEventEnvelope
      try {
        envelope = JSON.parse(raw) as ImportEventEnvelope
      } catch {
        return
      }
      const payload = envelope.data ?? {}
      const patch: Partial<ImportDto> = {}
      if (payload.to) patch.stage = payload.to
      if (payload.status === "failed") {
        patch.status = "failed"
        patch.failureReason = payload.reason ?? "The import failed."
      }
      if (payload.status === "completed") patch.status = "completed"
      if (payload.resumeAt) {
        // The `paused` event (GLOSSARY: Pause) — countdown surface.
        patch.status = "paused"
        patch.pausedProviderId = payload.providerId ?? null
        patch.pausedUntil = payload.resumeAt
      }
      listenerRef.current(patch)
    }

    source.addEventListener("snapshot", (event) => {
      try {
        const dto = JSON.parse(
          (event as MessageEvent<string>).data
        ) as ImportDto
        listenerRef.current(dto)
      } catch {
        // ignore malformed snapshot
      }
    })
    for (const type of [
      "stage_changed",
      "job_completed",
      "row_failed",
      "paused",
      "import_done",
    ]) {
      source.addEventListener(type, (event) =>
        applyEnvelope((event as MessageEvent<string>).data)
      )
    }
    return () => {
      source.close()
    }
  }, [importId])
}
