"use client"

/**
 * The import queue: every Import with live stage status driven by SSE (one
 * EventSource per import; snapshots re-sync, events patch). New uploads are
 * prepended by the dropzone.
 */
import { useCallback, useEffect, useState } from "react"

import { PIPELINE_STAGES, type Stage } from "@workspace/pipeline"
import Link from "next/link"
import { cn } from "@workspace/ui/lib/utils"

import type { ImportDto } from "@/lib/imports"

import { useImportEvents } from "@/hooks/use-import-events"
import { STAGE_LABELS, STATUS_STYLES } from "./import-labels"
import { UploadDropzone, type UploadResult } from "./upload-dropzone"

function LiveImport({ imported }: { imported: ImportDto }): React.ReactElement {
  const [current, setCurrent] = useState<ImportDto>(imported)
  const applyPatch = useCallback((patch: Partial<ImportDto>): void => {
    setCurrent((previous) => ({ ...previous, ...patch }))
  }, [])

  useImportEvents(
    // Terminal imports have nothing left to stream.
    current.status === "completed" || current.status === "failed"
      ? undefined
      : current.id,
    applyPatch
  )

  const stageLabel = STAGE_LABELS[current.stage as Stage] ?? current.stage
  const stageIndex = PIPELINE_STAGES.indexOf(current.stage as Stage)
  const status = STATUS_STYLES[current.status] ?? STATUS_STYLES.queued!

  return (
    <li className="flex flex-col gap-2 border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/imports/${current.id}`}
          className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
        >
          {current.originalFilename}
        </Link>
        <span
          className={cn(
            "px-1.5 py-0.5 text-[11px] font-medium",
            status.className
          )}
        >
          {status.label}
        </span>
      </div>
      {current.status === "failed" && current.failureReason ? (
        <p className="text-xs text-destructive">{current.failureReason}</p>
      ) : null}
      {current.status !== "failed" ? (
        <div className="flex items-center gap-2">
          <div
            className="flex h-1 flex-1 gap-1"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={PIPELINE_STAGES.length}
            aria-valuenow={stageIndex + 1}
            aria-label={`Stage ${stageLabel}`}
          >
            {PIPELINE_STAGES.map((stage, index) => (
              <div
                key={stage}
                className={cn(
                  "flex-1",
                  index <= stageIndex ? "bg-primary" : "bg-muted",
                  index === stageIndex &&
                    current.status === "running" &&
                    "animate-pulse"
                )}
              />
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {stageLabel}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {current.rowCount === null
            ? "rows pending intake"
            : `${current.rowCount.toLocaleString()} rows`}
        </span>
        <span className="uppercase">{current.sheetFormat}</span>
      </div>
    </li>
  )
}

export function ImportDashboard(): React.ReactElement {
  const [imports, setImports] = useState<ImportDto[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    const loadQueue = async (): Promise<void> => {
      try {
        const response = await fetch("/api/imports")
        if (!response.ok) return
        const payload = (await response.json()) as { imports: ImportDto[] }
        if (!cancelled) setImports(payload.imports)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void loadQueue()
    return () => {
      cancelled = true
    }
  }, [])

  const onUploaded = useCallback((result: UploadResult): void => {
    setImports((previous) => [
      result.import,
      ...previous.filter((item) => item.id !== result.import.id),
    ])
  }, [])

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-lg font-medium">Catalog imports</h1>
        <p className="text-sm text-muted-foreground">
          Drop a supplier sheet and its photos; processing runs in the
          background and progress appears here live.
        </p>
      </header>
      <UploadDropzone onUploaded={onUploaded} />
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Queue</h2>
        {loaded && imports.length === 0 ? (
          <p className="border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            No imports yet — upload a sheet to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {imports.map((item) => (
              <LiveImport key={item.id} imported={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
