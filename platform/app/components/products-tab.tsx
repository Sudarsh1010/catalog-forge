"use client"

/**
 * The Products review tab (spec user stories 20–24): a server-driven
 * catalog table — pagination 10/25/50/100, sortable columns, search and
 * filters — with per-field Confidence colour coding in every row, plus the
 * side-by-side review panel that opens beside the table. Bulk approve and
 * the per-product actions hit the oRPC `product` namespace; state lives in
 * the query string of this component, never in client-side sorting.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { PRODUCT_PAGE_SIZES, type ProductStatus } from "@workspace/contracts"

import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
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
import {
  CONFIDENCE_FIELDS,
  PRODUCT_STATUS_STYLES,
  CONFIDENCE_STYLES,
  confidenceBucket,
} from "./import-labels"
import { ProductPanel } from "./product-panel"

const BULK_ERROR = "Bulk approve could not run — try again."

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

type SortKey = "title" | "status" | "confidence" | "messiness" | "updatedAt"

const SORT_COLUMNS: Array<{ key: SortKey; label: string; class?: string }> = [
  { key: "title", label: "Product" },
  { key: "status", label: "Status", class: "w-28" },
  { key: "confidence", label: "Confidence", class: "w-44" },
  { key: "messiness", label: "Messiness", class: "w-20" },
  { key: "updatedAt", label: "Updated", class: "w-36" },
]

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

const SELECT_CLASS =
  "border border-border bg-background px-2 py-1.5 text-xs outline-none focus-visible:border-ring"

export function ProductsTab(): React.ReactElement {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(25)
  const [sort, setSort] = useState<SortKey>("updatedAt")
  const [dir, setDir] = useState<"asc" | "desc">("desc")
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput.trim(), 300)
  const [status, setStatus] = useState<"all" | ProductStatus>("all")
  const [confidence, setConfidence] = useState<
    "all" | "low" | "medium" | "high"
  >("all")
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)

  const listQuery = useQuery(
    orpc.product.list.queryOptions({
      input: {
        page,
        pageSize,
        sort,
        dir,
        status,
        confidence,
        search: search.length > 0 ? search : undefined,
      },
      placeholderData: keepPreviousData,
    })
  )
  const result = listQuery.data
  const rows = result?.rows ?? []
  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / result.pageSize))
    : 1

  const invalidateList = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: orpc.product.list.key() })
  }, [queryClient])

  const bulkMutation = useMutation({
    ...orpc.product.bulkApprove.mutationOptions(),
    onSuccess: (data) => {
      setBulkError(null)
      setSelected(new Set())
      if (data.skipped.length > 0) {
        setBulkError(
          `Approved ${data.approved}; skipped ${data.skipped.length} not yet enriched.`
        )
      }
      invalidateList()
    },
    onError: (error) => setBulkError(errorMessage(error, BULK_ERROR)),
  })

  const toggle = useCallback((id: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const pageAllSelected =
    rows.length > 0 && rows.every((row) => selected.has(row.id))
  const toggleAll = useCallback((): void => {
    setSelected((previous) =>
      previous.size > 0 ? new Set() : new Set(rows.map((row) => row.id))
    )
  }, [rows])

  const setSortColumn = useCallback(
    (key: SortKey): void => {
      if (key === sort) {
        setDir((previous) => (previous === "asc" ? "desc" : "asc"))
      } else {
        setSort(key)
        setDir(key === "title" || key === "status" ? "asc" : "desc")
      }
      setPage(1)
    },
    [sort]
  )

  const resetFilters = useCallback((apply: () => void): void => {
    apply()
    setPage(1)
    setSelected(new Set())
  }, [])

  const approvedSelection = useMemo(
    () =>
      rows.filter((row) => selected.has(row.id) && row.status !== "approved")
        .length,
    [rows, selected]
  )

  // The export download carries the tab's active search/filters (not the
  // page): the endpoints serve exactly the filtered catalog, in the
  // table's current sort order.
  const exportQuery = useMemo(() => {
    const params = new URLSearchParams({ sort, dir })
    if (search.length > 0) params.set("search", search)
    if (status !== "all") params.set("status", status)
    if (confidence !== "all") params.set("confidence", confidence)
    return params.toString()
  }, [search, status, confidence, sort, dir])

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* ---------------------------------------------------- toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={searchInput}
          placeholder="Search title, handle, key, brand…"
          aria-label="Search products"
          className={cn(SELECT_CLASS, "min-w-48 flex-1")}
          onChange={(event) =>
            resetFilters(() => setSearchInput(event.target.value))
          }
        />
        <select
          aria-label="Filter by status"
          className={SELECT_CLASS}
          value={status}
          onChange={(event) =>
            resetFilters(() => setStatus(event.target.value as typeof status))
          }
        >
          <option value="all">All statuses</option>
          <option value="ready">Ready</option>
          <option value="needs_review">Needs review</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
        </select>
        <select
          aria-label="Filter by confidence"
          className={SELECT_CLASS}
          value={confidence}
          onChange={(event) =>
            resetFilters(() =>
              setConfidence(event.target.value as typeof confidence)
            )
          }
        >
          <option value="all">All confidence</option>
          <option value="low">Low (&lt;70)</option>
          <option value="medium">Medium (70–89)</option>
          <option value="high">High (90+)</option>
        </select>
        <select
          aria-label="Rows per page"
          className={SELECT_CLASS}
          value={pageSize}
          onChange={(event) =>
            resetFilters(() => setPageSize(Number(event.target.value)))
          }
        >
          {PRODUCT_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
        <Button
          size="xs"
          disabled={selected.size === 0 || bulkMutation.isPending}
          onClick={() => bulkMutation.mutate({ ids: [...selected] })}
        >
          {bulkMutation.isPending
            ? "Approving…"
            : `Approve selected (${approvedSelection > 0 ? approvedSelection : selected.size})`}
        </Button>
        <a
          className={buttonVariants({ variant: "outline", size: "xs" })}
          href={`/api/products/export/csv?${exportQuery}`}
          title="Downloads every product matching the current filters (not just this page)"
        >
          Export CSV
        </a>
        <a
          className={buttonVariants({ variant: "outline", size: "xs" })}
          href={`/api/products/export/json?${exportQuery}`}
          title="Downloads every product matching the current filters (not just this page)"
        >
          Export JSON
        </a>
      </div>

      {bulkError ? (
        <Alert
          role="status"
          className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 [&>svg]:text-current"
        >
          <AlertDescription className="text-xs">{bulkError}</AlertDescription>
        </Alert>
      ) : null}
      {listQuery.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="text-xs">
            The catalog could not be loaded — try refreshing the page.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---------------------------------------------- table + panel */}
      <div
        className={cn(
          "grid min-w-0 items-start gap-4",
          openId
            ? "lg:grid-cols-[minmax(0,1fr),minmax(380px,460px)]"
            : "grid-cols-1"
        )}
      >
        <div className="flex min-w-0 flex-col gap-2">
          {listQuery.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <p className="border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              No products match — enrichment may not have run yet, or the
              filters are too narrow.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={pageAllSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all products on this page"
                    />
                  </TableHead>
                  {SORT_COLUMNS.map((column) => (
                    <TableHead
                      key={column.key}
                      className={column.class}
                      aria-sort={
                        sort === column.key
                          ? dir === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs hover:text-foreground"
                        onClick={() => setSortColumn(column.key)}
                      >
                        {column.label}
                        <span
                          aria-hidden
                          className="text-[10px] text-muted-foreground"
                        >
                          {sort === column.key
                            ? dir === "asc"
                              ? "▲"
                              : "▼"
                            : "↕"}
                        </span>
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="w-28 text-xs">Import</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-open={openId === row.id || undefined}
                    className="cursor-pointer data-open:bg-muted/60"
                    onClick={() => setOpenId(row.id)}
                  >
                    <TableCell
                      className="align-top"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(row.id)}
                        onCheckedChange={() => toggle(row.id)}
                        aria-label={`Select ${row.title}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-xs font-medium break-words">
                          {row.title}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {row.handle ?? row.naturalKey}
                        </span>
                        {row.editedByMerchant ? (
                          <Badge
                            variant="secondary"
                            className="w-fit bg-blue-500/15 text-[10px] text-blue-700 dark:text-blue-400"
                          >
                            merchant-edited
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge
                        variant="secondary"
                        className={
                          (
                            PRODUCT_STATUS_STYLES[row.status] ??
                            PRODUCT_STATUS_STYLES.pending!
                          ).className
                        }
                      >
                        {
                          (
                            PRODUCT_STATUS_STYLES[row.status] ??
                            PRODUCT_STATUS_STYLES.pending!
                          ).label
                        }
                      </Badge>
                      {row.reviewReasons.length > 0 ? (
                        <p
                          className="mt-1 line-clamp-2 max-w-56 text-[10px] text-amber-700 dark:text-amber-400"
                          title={row.reviewReasons.join(" ")}
                        >
                          {row.reviewReasons[0]}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap items-center gap-1">
                        {CONFIDENCE_FIELDS.map(({ key, label }) => {
                          const score = row.confidence[key]
                          if (score === undefined) return null
                          return (
                            <span
                              key={key}
                              title={`${label}: ${score}/100`}
                              className={cn(
                                "inline-flex h-4 min-w-8 items-center justify-center px-1 font-mono text-[10px]",
                                CONFIDENCE_STYLES[confidenceBucket(score)]
                              )}
                            >
                              {score}
                            </span>
                          )
                        })}
                        {Object.keys(row.confidence).length === 0 ? (
                          <span className="text-[11px] text-muted-foreground">
                            —
                          </span>
                        ) : null}
                      </div>
                      {row.minConfidence !== null ? (
                        <span className="mt-1 block text-[10px] text-muted-foreground tabular-nums">
                          min {Math.round(row.minConfidence)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top tabular-nums">
                      {row.messiness ?? "—"}
                    </TableCell>
                    <TableCell
                      className="align-top text-[11px] text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {new Date(row.updatedAt).toLocaleString(undefined, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                      {row.photoCount > 0 ? (
                        <span className="block">
                          {row.photoCount}{" "}
                          {row.photoCount === 1 ? "photo" : "photos"}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top text-[11px] text-muted-foreground">
                      <span
                        className="block max-w-32 truncate"
                        title={row.importFilename}
                      >
                        {row.importFilename}
                      </span>
                      {row.publishedLocales.length > 0 ? (
                        <span className="block font-mono text-[10px]">
                          {row.publishedLocales.join(" ")}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* --------------------------------------------- pagination */}
          {result && result.total > 0 ? (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span suppressHydrationWarning>
                {((result.page - 1) * result.pageSize + 1).toLocaleString()}–
                {Math.min(
                  result.page * result.pageSize,
                  result.total
                ).toLocaleString()}{" "}
                of {result.total.toLocaleString()} products
              </span>
              <span className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </Button>
                <span>
                  Page {result.page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={page >= totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </Button>
              </span>
            </div>
          ) : null}
        </div>

        {openId ? (
          <div className="border border-border p-3">
            <ProductPanel productId={openId} onClose={() => setOpenId(null)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
