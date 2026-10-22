"use client"

/**
 * Live per-Import progress over SSE: snapshot first, then stream events.
 * EventSource reconnects automatically and resends Last-Event-ID, so a
 * dropped connection resumes without gaps; the snapshot re-syncs state.
 *
 * Server state lives only in the query cache (ADR-0004): snapshots replace
 * the Import detail cache entry, envelope events merge patches over it, and
 * event bursts coalesce into one debounced cache invalidation so the read
 * model re-syncs from the DB of record.
 *
 * Stream events arrive as the worker's published envelope
 * `{ type, at, data }` — the payload fields live under `data`.
 */
import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { IMPORT_EVENT_TYPES } from "@workspace/pipeline"

import type { ImportDetailDto, ImportDto } from "@workspace/contracts"

import { orpc } from "@/lib/orpc"

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

/**
 * Subscribe to one import's event stream, writing patches straight into
 * the shared Import detail cache entry (dashboard rows and the detail page
 * observe the same data).
 */
export function useImportEvents(importId: string | undefined): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!importId) return
    const detailKey = orpc.import.detail.queryKey({ input: { id: importId } })

    // Coalesce event bursts (a stage completing fires one event per Job):
    // one debounced invalidation re-syncs from the DB of record.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = (): void => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: detailKey })
      }, 400)
    }

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
      queryClient.setQueryData(detailKey, (previous) =>
        previous ? { import: { ...previous.import, ...patch } } : previous
      )
      scheduleRefresh()
    }

    source.addEventListener("snapshot", (event) => {
      try {
        const dto = JSON.parse(
          (event as MessageEvent<string>).data
        ) as ImportDetailDto
        queryClient.setQueryData(detailKey, { import: dto })
      } catch {
        // ignore malformed snapshot
      }
    })
    for (const type of IMPORT_EVENT_TYPES) {
      source.addEventListener(type, (event) =>
        applyEnvelope((event as MessageEvent<string>).data)
      )
    }
    return () => {
      clearTimeout(refreshTimer)
      source.close()
    }
  }, [importId, queryClient])
}
