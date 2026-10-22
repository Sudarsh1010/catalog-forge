"use client"

/**
 * The per-Import surface: stage timeline with live per-stage Job counts,
 * the Row Ledger reconciliation, per-row errors with retry, Parked Photos
 * and the re-run enrichment selection — all kept live by the SSE hook
 * (snapshot first, then events; the DB of record re-syncs each burst).
 */
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"

import { PIPELINE_STAGES, type Stage } from "@workspace/pipeline"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import type {
  ImportDetailDto,
  ReconciliationDto,
  RowErrorDto,
  StageJobCounts,
} from "@/lib/imports"

import { useImportEvents } from "@/hooks/use-import-events"
import { STAGE_LABELS, STATUS_STYLES } from "./import-labels"

/** Ticking clock, only while `active` (the Pause countdown). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function StatusChip({ status }: { status: string }): React.ReactElement {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.queued!
  return (
    <span
      className={cn("px-1.5 py-0.5 text-[11px] font-medium", style.className)}
    >
      {style.label}
    </span>
  )
}

function EcTag({ ec }: { ec: string | null }): React.ReactElement | null {
  if (!ec) return null
  return (
    <span className="px-1 py-px text-[10px] tracking-wide text-muted-foreground uppercase ring-1 ring-border">
      {ec}
    </span>
  )
}

const SEGMENT_STYLES: Array<{
  key: keyof StageJobCounts
  className: string
  pulse?: boolean
}> = [
  { key: "completed", className: "bg-primary" },
  { key: "running", className: "bg-primary/60", pulse: true },
  { key: "failed", className: "bg-destructive" },
  { key: "pending", className: "bg-muted" },
]

function StageRow({
  stage,
  counts,
  current,
}: {
  stage: Stage
  counts: StageJobCounts
  current: string
}): React.ReactElement {
  const total =
    counts.pending + counts.running + counts.completed + counts.failed
  const label = STAGE_LABELS[stage]
  return (
    <li className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-xs",
            stage === current
              ? "font-medium text-foreground"
              : "text-muted-foreground"
          )}
        >
          {label}
        </span>
        {counts.failed > 0 ? (
          <span className="bg-destructive/15 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
            {counts.failed} failed
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          className="text-[11px] text-muted-foreground tabular-nums"
          suppressHydrationWarning
        >
          {total === 0 ? "not planned yet" : `${counts.completed}/${total}`}
        </span>
      </div>
      {total > 0 ? (
        <div
          className="flex h-1.5 gap-px"
          role="img"
          aria-label={`${label}: ${counts.pending} pending, ${counts.running} running, ${counts.completed} completed, ${counts.failed} failed`}
        >
          {SEGMENT_STYLES.map((segment) =>
            counts[segment.key] > 0 ? (
              <div
                key={segment.key}
                style={{ flexGrow: counts[segment.key] }}
                className={cn(
                  "min-w-1",
                  segment.className,
                  segment.pulse && "animate-pulse"
                )}
              />
            ) : null
          )}
        </div>
      ) : (
        <div className="h-1.5 bg-muted/50" aria-hidden="true" />
      )}
    </li>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: number
  className?: string
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn("text-base font-medium tabular-nums", className)}
        suppressHydrationWarning
      >
        {value.toLocaleString()}
      </span>
      <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
    </div>
  )
}

function Reconciliation({
  ledger,
}: {
  ledger: ReconciliationDto
}): React.ReactElement {
  if (ledger.sheetRows === null) {
    return (
      <p className="border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
        Waiting for intake to land the sheet rows — the ledger fills in as each
        stage finishes.
      </p>
    )
  }
  const accounted =
    ledger.done + ledger.needsReview + ledger.failed + (ledger.inProgress ?? 0)
  return (
    <div className="flex flex-col gap-3 border border-border bg-card px-3 py-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Done"
          value={ledger.done}
          className="text-emerald-700 dark:text-emerald-400"
        />
        <Stat
          label="Needs review"
          value={ledger.needsReview}
          className="text-amber-700 dark:text-amber-400"
        />
        <Stat
          label="Failed"
          value={ledger.failed}
          className="text-destructive"
        />
        <Stat label="In progress" value={ledger.inProgress ?? 0} />
      </div>
      <p
        className="text-xs text-muted-foreground"
        role="status"
        suppressHydrationWarning
      >
        {ledger.done} + {ledger.needsReview} + {ledger.failed} +{" "}
        {ledger.inProgress ?? 0} ={" "}
        <span className="font-medium text-foreground">
          {accounted.toLocaleString()}
        </span>{" "}
        of {ledger.sheetRows.toLocaleString()} sheet rows —{" "}
        {ledger.inProgress === 0
          ? "every row accounted for."
          : "in-flight rows land as the pipeline finishes."}
      </p>
    </div>
  )
}

function ErrorRow({
  error,
  retried,
  onRetry,
}: {
  error: RowErrorDto
  retried: boolean
  onRetry: (jobIds: string[]) => void
}): React.ReactElement {
  const retryable = error.jobIds.length > 0
  return (
    <li className="flex flex-col gap-1 border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Row {error.rowIndex}</span>
        <EcTag ec={error.ec} />
        <span className="flex-1" />
        {retryable ? (
          retried ? (
            <span className="text-[11px] text-muted-foreground">Requeued</span>
          ) : (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onRetry(error.jobIds)}
            >
              Retry
            </Button>
          )
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{error.reason}</p>
    </li>
  )
}

export function ImportDetail({
  initial,
}: {
  initial: ImportDetailDto
}): React.ReactElement {
  const [detail, setDetail] = useState<ImportDetailDto>(initial)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [retriedJobs, setRetriedJobs] = useState<ReadonlySet<string>>(new Set())
  const [retryAllBusy, setRetryAllBusy] = useState(false)
  const [rerunBusy, setRerunBusy] = useState(false)
  const [rerunNote, setRerunNote] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/imports/${initial.id}`)
      if (!response.ok) return
      const payload = (await response.json()) as { import: ImportDetailDto }
      setDetail(payload.import)
    } catch {
      // transient — the next event or a reload re-syncs
    }
  }, [initial.id])

  const refreshTimer = useRef<NodeJS.Timeout | undefined>(undefined)
  const scheduleRefresh = useCallback((): void => {
    clearTimeout(refreshTimer.current)
    // Coalesce event bursts (a stage completing fires one event per Job).
    refreshTimer.current = setTimeout(() => void refresh(), 400)
  }, [refresh])
  useEffect(
    () => () => {
      clearTimeout(refreshTimer.current)
    },
    []
  )

  const applyPatch = useCallback(
    (patch: Partial<ImportDetailDto>): void => {
      setDetail((previous) => ({ ...previous, ...patch }))
      scheduleRefresh()
    },
    [scheduleRefresh]
  )
  useImportEvents(initial.id, applyPatch)

  const paused = detail.status === "paused" && detail.pausedUntil !== null
  const now = useNow(paused)
  const minutesLeft = detail.pausedUntil
    ? Math.max(0, Math.ceil((Date.parse(detail.pausedUntil) - now) / 60_000))
    : 0

  const toggleProduct = useCallback((productId: string): void => {
    setRerunNote(null)
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      return next
    })
  }, [])

  const allSelected =
    detail.products.rows.length > 0 &&
    detail.products.rows.every((product) => selected.has(product.id))

  const toggleAll = useCallback((): void => {
    setRerunNote(null)
    setSelected((previous) =>
      previous.size > 0
        ? new Set()
        : new Set(detail.products.rows.map((p) => p.id))
    )
  }, [detail.products.rows])

  const retryJobs = useCallback(
    async (jobIds: string[]): Promise<void> => {
      setActionError(null)
      try {
        const response = await fetch(`/api/imports/${initial.id}/retries`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobIds }),
        })
        if (!response.ok) {
          setActionError("The retry could not be queued — try again.")
          return
        }
        setRetriedJobs((previous) => new Set([...previous, ...jobIds]))
        scheduleRefresh()
      } catch {
        setActionError("The retry could not be queued — try again.")
      }
    },
    [initial.id, scheduleRefresh]
  )

  const retryAll = useCallback(async (): Promise<void> => {
    setRetryAllBusy(true)
    setActionError(null)
    try {
      const response = await fetch(`/api/imports/${initial.id}/retries`, {
        method: "POST",
      })
      if (!response.ok) {
        setActionError("The retry could not be queued — try again.")
        return
      }
      scheduleRefresh()
    } catch {
      setActionError("The retry could not be queued — try again.")
    } finally {
      setRetryAllBusy(false)
    }
  }, [initial.id, scheduleRefresh])

  const rerunSelected = useCallback(async (): Promise<void> => {
    if (selected.size === 0) return
    setRerunBusy(true)
    setActionError(null)
    try {
      const response = await fetch(`/api/imports/${initial.id}/reruns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productIds: [...selected] }),
      })
      if (response.ok) {
        const payload = (await response.json()) as { requested: number }
        setRerunNote(
          `Re-run queued for ${payload.requested} ${payload.requested === 1 ? "product" : "products"} — statuses update as the worker finishes.`
        )
        setSelected(new Set())
        scheduleRefresh()
      } else {
        setActionError(
          "The re-run could not be recorded — refresh the page and try again."
        )
      }
    } catch {
      setActionError(
        "The re-run could not be recorded — refresh the page and try again."
      )
    } finally {
      setRerunBusy(false)
    }
  }, [initial.id, scheduleRefresh, selected])

  const created = new Date(detail.createdAt)

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/"
          className="w-fit text-xs text-muted-foreground hover:text-foreground"
        >
          ← Import queue
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 text-base font-medium break-all">
            {detail.originalFilename}
          </h1>
          <StatusChip status={detail.status} />
        </div>
        <p className="text-xs text-muted-foreground" suppressHydrationWarning>
          {detail.rowCount === null
            ? "rows pending intake"
            : `${detail.rowCount.toLocaleString()} rows`}{" "}
          · {detail.sheetFormat.toUpperCase()} ·{" "}
          {created.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}{" "}
          · <span className="font-mono">{detail.contentHash.slice(0, 12)}</span>
        </p>
        {paused ? (
          <div
            role="status"
            className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
            suppressHydrationWarning
          >
            Paused
            {detail.pausedProviderId ? ` (${detail.pausedProviderId})` : ""} —
            resuming{" "}
            {minutesLeft > 0
              ? `in ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"}`
              : "any moment"}
            . The provider throttled this import; processing resumes
            automatically.
          </div>
        ) : null}
        {detail.status === "failed" && detail.failureReason ? (
          <div
            role="alert"
            className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {detail.failureReason}
          </div>
        ) : null}
      </header>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Pipeline</h2>
        <p className="text-xs text-muted-foreground">
          Live job counts per stage, straight off the work queue.
        </p>
        <ol>
          {PIPELINE_STAGES.map((stage) => (
            <StageRow
              key={stage}
              stage={stage}
              counts={detail.stages[stage]}
              current={detail.stage}
            />
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Row ledger</h2>
        <Reconciliation ledger={detail.reconciliation} />
      </section>

      {detail.errors.total > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">
              Errors ({detail.errors.total.toLocaleString()})
            </h2>
            <Button
              variant="outline"
              size="xs"
              disabled={retryAllBusy}
              onClick={() => void retryAll()}
            >
              {retryAllBusy ? "Queueing…" : "Retry all failed jobs"}
            </Button>
          </div>
          {actionError ? (
            <p className="text-xs text-destructive">{actionError}</p>
          ) : null}
          {detail.errors.rows.length < detail.errors.total ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {detail.errors.rows.length} of{" "}
              {detail.errors.total.toLocaleString()} failed rows.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {detail.errors.rows.map((error) => (
              <ErrorRow
                key={error.rowIndex}
                error={error}
                retried={error.jobIds.every((jobId) => retriedJobs.has(jobId))}
                onRetry={(jobIds) => void retryJobs(jobIds)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {detail.parkedPhotos.total > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            Parked photos ({detail.parkedPhotos.total.toLocaleString()})
          </h2>
          <ul className="flex flex-col gap-2">
            {detail.parkedPhotos.rows.map((photo) => (
              <li
                key={photo.filename}
                className="flex flex-col gap-0.5 border border-border bg-card px-3 py-2"
              >
                <span className="text-xs font-medium break-all">
                  {photo.filename}
                </span>
                <p className="text-xs text-muted-foreground">{photo.reason}</p>
              </li>
            ))}
          </ul>
          {detail.parkedPhotos.rows.length < detail.parkedPhotos.total ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {detail.parkedPhotos.rows.length} of{" "}
              {detail.parkedPhotos.total.toLocaleString()}.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Products ({detail.products.total.toLocaleString()})
          </h2>
          <Button
            size="xs"
            disabled={selected.size === 0 || rerunBusy}
            onClick={() => void rerunSelected()}
          >
            {rerunBusy
              ? "Queueing…"
              : selected.size > 0
                ? `Re-run enrichment (${selected.size})`
                : "Re-run enrichment"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Select products to redo their enrichment — recorded as a re-run the
          worker picks up, exactly like a retry.
        </p>
        {rerunNote ? (
          <p
            className="text-xs text-emerald-700 dark:text-emerald-400"
            role="status"
          >
            {rerunNote}
          </p>
        ) : null}
        {actionError ? (
          <p className="text-xs text-destructive">{actionError}</p>
        ) : null}
        {detail.products.rows.length === 0 ? (
          <p className="border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No products yet — grouping hasn&apos;t run.
          </p>
        ) : (
          <>
            <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={allSelected}
                onChange={toggleAll}
                aria-label="Select all products"
              />
              Select all
              {detail.products.rows.length < detail.products.total
                ? ` (first ${detail.products.rows.length})`
                : ""}
            </label>
            <ul className="flex flex-col gap-2">
              {detail.products.rows.map((product) => (
                <li
                  key={product.id}
                  className="flex items-start gap-2.5 border border-border bg-card px-3 py-2"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-primary"
                    checked={selected.has(product.id)}
                    onChange={() => toggleProduct(product.id)}
                    aria-label={`Select ${product.title}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 flex-1 basis-48 text-xs font-medium break-words">
                        {product.title}
                      </span>
                      {product.enrichmentStatus === "ready" ? (
                        <span className="bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                          Ready
                        </span>
                      ) : product.enrichmentStatus === "needs_review" ? (
                        <span className="bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                          Needs review
                        </span>
                      ) : (
                        <span className="bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          Not enriched
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {product.naturalKey}
                    </span>
                    {product.reviewReason ? (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        {product.reviewReason}
                      </p>
                    ) : null}
                    {product.enrichedAt ? (
                      <span
                        className="text-[11px] text-muted-foreground"
                        suppressHydrationWarning
                      >
                        Enriched{" "}
                        {new Date(product.enrichedAt).toLocaleTimeString(
                          undefined,
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          }
                        )}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
