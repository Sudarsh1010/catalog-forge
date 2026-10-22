"use client"

/**
 * The Metrics tab (ticket #19): processing rates from the Row Ledger,
 * model usage, cost over time, call speed, translation coverage with the
 * Out-of-Date count, and cheap/strong routing savings. Every block is a
 * read of one Postgres view via the `metrics.overview` procedure — the
 * component never aggregates beyond what the views return.
 */
import { useQuery } from "@tanstack/react-query"
import type { MetricsOverviewDto } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Skeleton } from "@workspace/ui/components/skeleton"
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

/** Integer micros → a merchant-readable currency string. */
function money(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

const RATE_SEGMENTS = [
  {
    key: "doneRows",
    pctKey: "donePct",
    label: "Done",
    className: "bg-primary",
  },
  {
    key: "needsReviewRows",
    pctKey: "needsReviewPct",
    label: "Needs Review",
    className: "bg-amber-500",
  },
  {
    key: "failedRows",
    pctKey: "failedPct",
    label: "Failed",
    className: "bg-destructive",
  },
] as const

function RatesCard({ rates }: { rates: MetricsOverviewDto["rates"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Products processed</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
          {RATE_SEGMENTS.map((segment) =>
            rates[segment.pctKey] > 0 ? (
              <div
                key={segment.key}
                className={cn("h-full", segment.className)}
                style={{ width: `${rates[segment.pctKey]}%` }}
              />
            ) : null
          )}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {RATE_SEGMENTS.map((segment) => (
            <div key={segment.key} className="flex items-center gap-1.5">
              <span
                className={cn("size-2 rounded-full", segment.className)}
                aria-hidden
              />
              <span className="text-xs text-muted-foreground">
                {segment.label}
              </span>
              <span className="text-xs font-medium tabular-nums">
                {rates[segment.key].toLocaleString()} ({rates[segment.pctKey]}%)
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">
          {rates.totalRows.toLocaleString()} sheet rows accounted — reconciles
          with the Row Ledger.
        </p>
      </CardContent>
    </Card>
  )
}

function CostOverTimeCard({
  days,
}: {
  days: MetricsOverviewDto["costOverTime"]
}) {
  const max = Math.max(...days.map((day) => day.costMicros), 1)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Cost over time</CardTitle>
      </CardHeader>
      <CardContent>
        {days.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No provider calls yet.
          </p>
        ) : (
          <div className="flex h-28 items-end gap-1.5">
            {days.map((day) => (
              <div
                key={day.day}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${day.day}: ${money(day.costMicros)} (${day.calls} calls)`}
              >
                <div
                  className="w-full rounded-t bg-primary/80"
                  style={{
                    height: `${Math.max((day.costMicros / max) * 100, 2)}%`,
                  }}
                />
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {day.day.slice(5)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ModelUsageTable({ rows }: { rows: MetricsOverviewDto["modelUsage"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Model usage</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Provider</TableHead>
              <TableHead className="text-xs">Model</TableHead>
              <TableHead className="text-xs">Operation</TableHead>
              <TableHead className="text-right text-xs">Calls</TableHead>
              <TableHead className="text-right text-xs">Tokens in</TableHead>
              <TableHead className="text-right text-xs">Tokens out</TableHead>
              <TableHead className="text-right text-xs">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-xs text-muted-foreground"
                >
                  No provider usage recorded.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={`${row.providerId}/${row.model}/${row.operation}`}
                >
                  <TableCell className="text-xs">{row.providerId}</TableCell>
                  <TableCell className="text-xs font-medium">
                    {row.model}
                  </TableCell>
                  <TableCell className="text-xs">{row.operation}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.calls.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.tokensIn.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.tokensOut.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(row.costMicros)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function SpeedTable({ rows }: { rows: MetricsOverviewDto["speed"] }) {
  const max = Math.max(...rows.map((row) => row.slowestDurationMs ?? 0), 1)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Speed (avg / slowest per model)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Provider</TableHead>
              <TableHead className="text-xs">Model</TableHead>
              <TableHead className="text-xs">Operation</TableHead>
              <TableHead className="text-right text-xs">Calls</TableHead>
              <TableHead className="text-right text-xs">Avg</TableHead>
              <TableHead className="w-48 text-right text-xs">Slowest</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-xs text-muted-foreground"
                >
                  No timed provider calls yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={`${row.providerId}/${row.model}/${row.operation}`}
                >
                  <TableCell className="text-xs">{row.providerId}</TableCell>
                  <TableCell className="text-xs font-medium">
                    {row.model}
                  </TableCell>
                  <TableCell className="text-xs">{row.operation}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.calls.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.avgDurationMs === null
                      ? "—"
                      : `${Math.round(row.avgDurationMs).toLocaleString()} ms`}
                  </TableCell>
                  <TableCell className="text-right align-middle">
                    <span className="text-xs tabular-nums">
                      {row.slowestDurationMs === null
                        ? "—"
                        : `${row.slowestDurationMs.toLocaleString()} ms`}
                    </span>
                    <span className="mt-1 block h-1.5 w-full rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary/70"
                        style={{
                          width: `${((row.slowestDurationMs ?? 0) / max) * 100}%`,
                        }}
                      />
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function CoverageTable({
  rows,
}: {
  rows: MetricsOverviewDto["translationCoverage"]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Translation coverage</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Locale</TableHead>
              <TableHead className="text-right text-xs">Products</TableHead>
              <TableHead className="text-right text-xs">Fields</TableHead>
              <TableHead className="w-40 text-xs">Coverage</TableHead>
              <TableHead className="text-right text-xs">Out of date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.locale}>
                <TableCell className="text-xs font-medium uppercase">
                  {row.locale}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {row.productsTranslated.toLocaleString()} /{" "}
                  {row.productsEnriched.toLocaleString()}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {row.fieldsTranslated.toLocaleString()}
                </TableCell>
                <TableCell>
                  <span className="text-xs tabular-nums">
                    {row.coveragePct}%
                  </span>
                  <span className="mt-1 block h-1.5 w-full rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary/70"
                      style={{ width: `${Math.min(row.coveragePct, 100)}%` }}
                    />
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  {row.outOfDate > 0 ? (
                    <Badge variant="outline" className="text-[10px]">
                      {row.outOfDate.toLocaleString()}
                    </Badge>
                  ) : (
                    <span className="text-xs tabular-nums">0</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function SavingsTable({
  rows,
}: {
  rows: MetricsOverviewDto["routingSavings"]
}) {
  const totalSaved = rows.reduce((sum, row) => sum + row.savedMicros, 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Cheap/strong routing savings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground tabular-nums">
          Saved vs. running every cheap call on the strong model:{" "}
          <span className="font-medium text-foreground">
            {money(totalSaved)}
          </span>
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Model</TableHead>
              <TableHead className="text-xs">Operation</TableHead>
              <TableHead className="text-right text-xs">Calls</TableHead>
              <TableHead className="text-right text-xs">Actual</TableHead>
              <TableHead className="text-right text-xs">
                Strong-model cost
              </TableHead>
              <TableHead className="text-right text-xs">Saved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-xs text-muted-foreground"
                >
                  No routed cheap calls yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={`${row.providerId}/${row.model}/${row.operation}`}
                >
                  <TableCell className="text-xs font-medium">
                    {row.model}
                  </TableCell>
                  <TableCell className="text-xs">{row.operation}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.calls.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(row.actualCostMicros)}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {money(row.strongCostMicros)}
                  </TableCell>
                  <TableCell className="text-right text-xs font-medium tabular-nums">
                    {money(row.savedMicros)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

export function MetricsPanel(): React.ReactElement {
  const query = useQuery(orpc.metrics.overview.queryOptions())

  if (query.isPending) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <p className="text-sm text-destructive">
        The metrics could not be loaded — try again.
      </p>
    )
  }

  const overview = query.data

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <RatesCard rates={overview.rates} />
        <CostOverTimeCard days={overview.costOverTime} />
      </div>
      <ModelUsageTable rows={overview.modelUsage} />
      <SpeedTable rows={overview.speed} />
      <div className="grid gap-4 md:grid-cols-2">
        <CoverageTable rows={overview.translationCoverage} />
        <SavingsTable rows={overview.routingSavings} />
      </div>
    </div>
  )
}
