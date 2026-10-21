"use client"

/**
 * Live per-Import progress over SSE: snapshot first, then stream events.
 * EventSource reconnects automatically and resends Last-Event-ID, so a
 * dropped connection resumes without gaps; the snapshot re-syncs state.
 */
import { useEffect, useRef } from "react"

import type { ImportDto } from "@/lib/imports"

interface ImportEventPayload {
  importId?: string
  from?: string
  to?: string
  status?: string
  reason?: string
  rowCount?: number
}

type Listener = (patch: Partial<ImportDto>) => void

/**
 * Subscribe to one import's event stream. The listener receives patches
 * derived from SSE events; the initial snapshot patches the full state.
 */
export function useImportEvents(
  importId: string | undefined,
  listener: Listener
): void {
  const listenerRef = useRef(listener)
  listenerRef.current = listener

  useEffect(() => {
    if (!importId) return
    const source = new EventSource(`/api/imports/${importId}/events`)

    const applyPayload = (raw: string): void => {
      let payload: ImportEventPayload
      try {
        payload = JSON.parse(raw) as ImportEventPayload
      } catch {
        return
      }
      const patch: Partial<ImportDto> = {}
      if (payload.to) patch.stage = payload.to
      if (payload.status === "failed") {
        patch.status = "failed"
        patch.failureReason = payload.reason ?? "The import failed."
      }
      if (payload.status === "completed") patch.status = "completed"
      if (typeof payload.rowCount === "number")
        patch.rowCount = payload.rowCount
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
        applyPayload((event as MessageEvent<string>).data)
      )
    }
    return () => {
      source.close()
    }
  }, [importId])
}
