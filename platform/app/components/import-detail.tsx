"use client"

/**
 * The per-Import surface: stage timeline with live per-stage Job counts,
 * the Row Ledger reconciliation, per-row errors with retry, Parked Photos
 * and the re-run enrichment selection. Server state lives only in the
 * query cache (ADR-0004): the server-rendered snapshot seeds the shared
 * Import detail entry, the SSE hook keeps it live, and retry/re-run are
 * oRPC mutations. Genuinely-local UI state (re-run selection, retried-job
 * markers, the ticking Pause clock) stays in useState.
 */
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PIPELINE_STAGES, type Stage } from "@workspace/pipeline"
import type {
  ImportDetailDto,
  ReconciliationDto,
  RowErrorDto,
  StageJobCounts,
} from "@workspace/contracts"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"

import { orpc } from "@/lib/orpc"
import { useImportEvents } from "@/hooks/use-import-events"
import { STAGE_LABELS, STATUS_STYLES } from "./import-labels"

const RETRY_ERROR = "The retry could not be queued — try again."
const RERUN_ERROR =
  "The re-run could not be recorded — refresh the page and try again."

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

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

function EcTag({ ec }: { ec: string | null }): React.ReactElement | null {
  if (!ec) return null
  return (
    <Badge variant="outline" className="text-[10px] tracking-wide uppercase">
      {ec}
    </Badge>
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
          <Badge variant="destructive" className="text-[11px]">
            {counts.failed} failed
          </Badge>
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
      <p className="text-xs text-muted-foreground">
        Waiting for intake to land the sheet rows — the ledger fills in as each
        stage finishes.
      </p>
    )
  }
  const accounted =
    ledger.done + ledger.needsReview + ledger.failed + (ledger.inProgress ?? 0)
  return (
    <div className="flex flex-col gap-3">
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
  retryBusy,
}: {
  error: RowErrorDto
  retried: boolean
  onRetry: (jobIds: string[]) => void
  retryBusy: boolean
}): React.ReactElement {
  const retryable = error.jobIds.length > 0
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="text-xs font-medium tabular-nums">
          Row {error.rowIndex}
        </span>
      </TableCell>
      <TableCell className="align-top">
        <EcTag ec={error.ec} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {error.reason}
      </TableCell>
      <TableCell className="text-right align-top">
        {retryable ? (
          retried ? (
            <span className="text-[11px] text-muted-foreground">Requeued</span>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={retryBusy}
              onClick={() => onRetry(error.jobIds)}
            >
              Retry
            </Button>
          )
        ) : null}
      </TableCell>
    </TableRow>
  )
}

export function ImportDetail({
  initial,
}: {
  initial: ImportDetailDto
}): React.ReactElement {
  const id = initial.id
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [retriedJobs, setRetriedJobs] = useState<ReadonlySet<string>>(new Set())

  // The shared cache entry — the SSE hook patches the same data the
  // dashboard rows observe; the server snapshot only seeds first paint.
  const detailQuery = useQuery(
    orpc.import.detail.queryOptions({
      input: { id },
      initialData: { import: initial },
    })
  )
  const detail = detailQuery.data?.import ?? initial
  useImportEvents(id)

  const invalidateDetail = useCallback((): void => {
    void queryClient.invalidateQueries({
      queryKey: orpc.import.detail.queryKey({ input: { id } }),
    })
  }, [id, queryClient])

  const retryMutation = useMutation({
    ...orpc.import.retry.mutationOptions(),
    onSuccess: (_data, variables) => {
      if (variables.jobIds?.length) {
        setRetriedJobs(
          (previous) => new Set([...previous, ...variables.jobIds!])
        )
      }
      invalidateDetail()
    },
  })
  const rerunMutation = useMutation({
    ...orpc.import.rerun.mutationOptions(),
    onSuccess: () => {
      setSelected(new Set())
      invalidateDetail()
    },
  })

  const retryJobs = useCallback(
    (jobIds: string[]): void => retryMutation.mutate({ id, jobIds }),
    [id, retryMutation]
  )
  const retryAll = useCallback(
    (): void => retryMutation.mutate({ id }),
    [id, retryMutation]
  )
  const rerunSelected = useCallback((): void => {
    if (selected.size === 0) return
    rerunMutation.mutate({ id, productIds: [...selected] })
  }, [id, rerunMutation, selected])

  const paused = detail.status === "paused" && detail.pausedUntil !== null
  const now = useNow(paused)
  const minutesLeft = detail.pausedUntil
    ? Math.max(0, Math.ceil((Date.parse(detail.pausedUntil) - now) / 60_000))
    : 0

  const toggleProduct = useCallback((productId: string): void => {
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
    setSelected((previous) =>
      previous.size > 0
        ? new Set()
        : new Set(detail.products.rows.map((p) => p.id))
    )
  }, [detail.products.rows])

  const retryBusy = retryMutation.isPending
  const rerunBusy = rerunMutation.isPending
  const actionError = retryMutation.error
    ? errorMessage(retryMutation.error, RETRY_ERROR)
    : rerunMutation.error
      ? errorMessage(rerunMutation.error, RERUN_ERROR)
      : null
  const rerunNote = rerunMutation.data
    ? `Re-run queued for ${rerunMutation.data.requested} ${rerunMutation.data.requested === 1 ? "product" : "products"} — statuses update as the worker finishes.`
    : null

  const status = STATUS_STYLES[detail.status] ?? STATUS_STYLES.queued!
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
          <Badge variant="secondary" className={status.className}>
            {status.label}
          </Badge>
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
          <Alert
            role="status"
            className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 [&>svg]:text-current"
            suppressHydrationWarning
          >
            <AlertDescription className="text-xs">
              Paused
              {detail.pausedProviderId ? ` (${detail.pausedProviderId})` : ""} —
              resuming{" "}
              {minutesLeft > 0
                ? `in ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"}`
                : "any moment"}
              . The provider throttled this import; processing resumes
              automatically.
            </AlertDescription>
          </Alert>
        ) : null}
        {detail.status === "failed" && detail.failureReason ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="text-xs">
              {detail.failureReason}
            </AlertDescription>
          </Alert>
        ) : null}
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Pipeline</CardTitle>
          <p className="text-xs text-muted-foreground">
            Live job counts per stage, straight off the work queue.
          </p>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Row ledger</CardTitle>
        </CardHeader>
        <CardContent>
          <Reconciliation ledger={detail.reconciliation} />
        </CardContent>
      </Card>

      {detail.errors.total > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Errors ({detail.errors.total.toLocaleString()})
            </CardTitle>
            <CardAction>
              <Button
                variant="outline"
                size="xs"
                disabled={retryBusy}
                onClick={retryAll}
              >
                {retryBusy ? "Queueing…" : "Retry all failed jobs"}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {actionError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription className="text-xs">
                  {actionError}
                </AlertDescription>
              </Alert>
            ) : null}
            {detail.errors.rows.length < detail.errors.total ? (
              <p className="text-xs text-muted-foreground">
                Showing the first {detail.errors.rows.length} of{" "}
                {detail.errors.total.toLocaleString()} failed rows.
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20 text-xs">Row</TableHead>
                  <TableHead className="w-24 text-xs">EC</TableHead>
                  <TableHead className="text-xs">Reason</TableHead>
                  <TableHead className="w-24 text-right text-xs">
                    Action
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.errors.rows.map((error) => (
                  <ErrorRow
                    key={error.rowIndex}
                    error={error}
                    retried={error.jobIds.every((jobId) =>
                      retriedJobs.has(jobId)
                    )}
                    onRetry={retryJobs}
                    retryBusy={retryBusy}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {detail.parkedPhotos.total > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Parked photos ({detail.parkedPhotos.total.toLocaleString()})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Filename</TableHead>
                  <TableHead className="text-xs">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.parkedPhotos.rows.map((photo) => (
                  <TableRow key={photo.filename}>
                    <TableCell className="text-xs font-medium break-all">
                      {photo.filename}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {photo.reason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {detail.parkedPhotos.rows.length < detail.parkedPhotos.total ? (
              <p className="text-xs text-muted-foreground">
                Showing the first {detail.parkedPhotos.rows.length} of{" "}
                {detail.parkedPhotos.total.toLocaleString()}.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Products ({detail.products.total.toLocaleString()})
          </CardTitle>
          <CardAction>
            <Button
              size="xs"
              disabled={selected.size === 0 || rerunBusy}
              onClick={rerunSelected}
            >
              {rerunBusy
                ? "Queueing…"
                : selected.size > 0
                  ? `Re-run enrichment (${selected.size})`
                  : "Re-run enrichment"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
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
            <Alert variant="destructive" role="alert">
              <AlertDescription className="text-xs">
                {actionError}
              </AlertDescription>
            </Alert>
          ) : null}
          {detail.products.rows.length === 0 ? (
            <p className="border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              No products yet — grouping hasn&apos;t run.
            </p>
          ) : (
            <>
              <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all products"
                />
                Select all
                {detail.products.rows.length < detail.products.total
                  ? ` (first ${detail.products.rows.length})`
                  : ""}
              </label>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">Select</span>
                    </TableHead>
                    <TableHead className="text-xs">Product</TableHead>
                    <TableHead className="w-32 text-xs">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.products.rows.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="align-top">
                        <Checkbox
                          className="mt-0.5"
                          checked={selected.has(product.id)}
                          onCheckedChange={() => toggleProduct(product.id)}
                          aria-label={`Select ${product.title}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-xs font-medium break-words">
                            {product.title}
                          </span>
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
                      </TableCell>
                      <TableCell className="align-top">
                        {product.enrichmentStatus === "ready" ? (
                          <Badge
                            variant="secondary"
                            className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          >
                            Ready
                          </Badge>
                        ) : product.enrichmentStatus === "needs_review" ? (
                          <Badge
                            variant="secondary"
                            className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          >
                            Needs review
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="bg-muted text-muted-foreground"
                          >
                            Not enriched
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Translations ({detail.translations.total.toLocaleString()})
            {detail.translations.outOfDate > 0 ? (
              <span className="ml-2 text-amber-700 dark:text-amber-400">
                {detail.translations.outOfDate.toLocaleString()} out of date
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {detail.translations.rows.length === 0 ? (
            <p className="border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              No translations yet — translation hasn&apos;t run.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Product</TableHead>
                  <TableHead className="w-16 text-xs">Locale</TableHead>
                  <TableHead className="w-24 text-xs">Field</TableHead>
                  <TableHead className="w-20 text-xs">Origin</TableHead>
                  <TableHead className="w-28 text-xs">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.translations.rows.map((translation) => (
                  <TableRow
                    key={`${translation.productId}:${translation.locale}:${translation.field}`}
                  >
                    <TableCell className="text-xs break-words">
                      {translation.productTitle}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {translation.locale}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {translation.field}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={
                          translation.origin === "manual"
                            ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {translation.origin}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {translation.outOfDate ? (
                        <Badge
                          variant="secondary"
                          className="bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        >
                          Out of date
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        >
                          Current
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
