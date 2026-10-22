"use client"

/**
 * The import queue (ADR-0004 read-only dashboard state): every Import with
 * live stage status. Server state lives only in the query cache — the list
 * query feeds the queue, and each row subscribes to the shared Import
 * detail entry (seeded from the list row) that the SSE hook patches.
 */
import { useQuery } from "@tanstack/react-query"
import { PIPELINE_STAGES, type Stage } from "@workspace/pipeline"
import type { ImportDto } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import Link from "next/link"

import { orpc } from "@/lib/orpc"
import { useImportEvents } from "@/hooks/use-import-events"
import { STAGE_LABELS, STATUS_STYLES } from "./import-labels"
import { DashboardNav } from "./dashboard-nav"
import { UploadDropzone } from "./upload-dropzone"

function LiveImport({ imported }: { imported: ImportDto }): React.ReactElement {
  // One cache entry per import, shared with the detail page. Until the
  // detail query resolves, the row renders the list row it came from.
  const detailQuery = useQuery(
    orpc.import.detail.queryOptions({ input: { id: imported.id } })
  )
  const current = detailQuery.data?.import ?? imported

  // Terminal imports have nothing left to stream.
  useImportEvents(
    current.status === "completed" || current.status === "failed"
      ? undefined
      : current.id
  )

  const stageLabel = STAGE_LABELS[current.stage as Stage] ?? current.stage
  const stageIndex = PIPELINE_STAGES.indexOf(current.stage as Stage)
  const status = STATUS_STYLES[current.status] ?? STATUS_STYLES.queued!

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/imports/${current.id}`}
            className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
          >
            {current.originalFilename}
          </Link>
          <Badge variant="secondary" className={status.className}>
            {status.label}
          </Badge>
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
          <span className="tabular-nums">
            {current.rowCount === null
              ? "rows pending intake"
              : `${current.rowCount.toLocaleString()} rows`}
          </span>
          <span className="uppercase">{current.sheetFormat}</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function ImportDashboard(): React.ReactElement {
  const listQuery = useQuery(
    orpc.import.list.queryOptions({ input: undefined })
  )
  const imports = listQuery.data?.imports

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <DashboardNav active="/" />
        <h1 className="font-heading text-lg font-medium">Catalog imports</h1>
        <p className="text-sm text-muted-foreground">
          Drop a supplier sheet and its photos; processing runs in the
          background and progress appears here live.
        </p>
      </header>
      <UploadDropzone />
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Queue</h2>
        {listQuery.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : listQuery.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              The queue could not be loaded — try refreshing the page.
            </AlertDescription>
          </Alert>
        ) : imports!.length === 0 ? (
          <p className="border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
            No imports yet — upload a sheet to get started.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {imports!.map((item) => (
              <LiveImport key={item.id} imported={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
