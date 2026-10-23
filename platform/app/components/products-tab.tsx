"use client"

/**
 * The Products review tab (spec user stories 20–24): a server-driven
 * catalog table. The RSC page runs the catalog query and hands the result
 * down; this component only manages view state, and every view-state
 * change is a URL update — the page re-renders server-side with the new
 * rows in the same roundtrip. Writes (edit / approve / bulk approve /
 * send back) go through server actions that revalidate the route.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react"
import { useRouter } from "next/navigation"
import type { ProductDetailDto, ProductListResult } from "@workspace/contracts"
import { PRODUCT_PAGE_SIZES } from "@workspace/contracts"

import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
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

import type { ProductListQuery } from "@/lib/products"
import type { ProductTabActions } from "@/app/products/actions"
import {
  CONFIDENCE_FIELDS,
  PRODUCT_STATUS_STYLES,
  CONFIDENCE_STYLES,
  confidenceBucket,
} from "./import-labels"
import { ProductPanel } from "./product-panel"

type SortKey = ProductListQuery["sort"]

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

export interface ProductsTabProps {
  /** The server-rendered catalog page (already filtered/sorted/paged). */
  initial: ProductListResult
  /** The view state the server used — mirrored from the query string. */
  query: ProductListQuery
  /** Server-loaded panel detail for `openId` (null when it has none). */
  detail: ProductDetailDto | null
  openId: string | undefined
  /** Server actions, imported in the RSC page and passed down. */
  actions: ProductTabActions
}

export function ProductsTab({
  initial,
  query,
  detail,
  openId,
  actions,
}: ProductsTabProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [searchInput, setSearchInput] = useState(query.search ?? "")
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [bulkMessage, setBulkMessage] = useState<string | null>(null)
  const [bulkPending, setBulkPending] = useState(false)

  const rows = initial.rows
  const totalPages = Math.max(1, Math.ceil(initial.total / initial.pageSize))

  /** View-state updates are URL updates; the server renders the result. */
  const updateQuery = useCallback(
    (changes: Partial<Record<string, string | undefined>>) => {
      const params = new URLSearchParams()
      const merged: Record<string, string | undefined> = {
        page: String(query.page),
        pageSize: String(query.pageSize),
        sort: query.sort,
        dir: query.dir,
        status: query.status,
        confidence: query.confidence,
        q: query.search,
        open: openId,
        ...changes,
      }
      // Omit defaults so URLs stay clean and shareable.
      const defaults: Record<string, string> = {
        page: "1",
        pageSize: "25",
        sort: "updatedAt",
        dir: "desc",
        status: "all",
        confidence: "all",
      }
      for (const [key, value] of Object.entries(merged)) {
        if (value === undefined || value === defaults[key]) continue
        params.set(key, value)
      }
      const queryString = params.toString()
      startTransition(() => {
        router.push(`/products${queryString ? `?${queryString}` : ""}`, {
          scroll: false,
        })
      })
    },
    [openId, query, router]
  )

  // Debounced search: push once the input settles; the URL is the truth,
  // so re-sync the input when the server round-trip lands (back/forward
  // included).
  const search = useDebouncedValue(searchInput.trim(), 300)
  const lastPushedSearch = useRef(query.search ?? "")
  useEffect(() => {
    setSearchInput(query.search ?? "")
    lastPushedSearch.current = query.search ?? ""
  }, [query.search])
  useEffect(() => {
    if (search === lastPushedSearch.current) return
    lastPushedSearch.current = search
    updateQuery({ q: search.length > 0 ? search : undefined, page: undefined })
  }, [search, updateQuery])

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

  /** View changes re-render the table — drop stale row selections. */
  const setSortColumn = useCallback(
    (key: SortKey): void => {
      const dir =
        key === query.sort
          ? query.dir === "asc"
            ? "desc"
            : "asc"
          : key === "title" || key === "status"
            ? "asc"
            : "desc"
      setSelected(new Set())
      updateQuery({ sort: key, dir, page: undefined })
    },
    [query.dir, query.sort, updateQuery]
  )

  const changeFilter = useCallback(
    (changes: Partial<Record<string, string | undefined>>): void => {
      setSelected(new Set())
      updateQuery({ ...changes, page: undefined })
    },
    [updateQuery]
  )

  const approvedSelection = useMemo(
    () =>
      rows.filter((row) => selected.has(row.id) && row.status !== "approved")
        .length,
    [rows, selected]
  )

  const bulkApprove = useCallback((): void => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkPending(true)
    startTransition(async () => {
      const result = await actions.bulkApprove(ids)
      setBulkPending(false)
      setSelected(new Set())
      if (result.ok) {
        setBulkMessage(
          result.skipped.length > 0
            ? `Approved ${result.approved}; skipped ${result.skipped.length} not yet enriched.`
            : null
        )
      } else {
        setBulkMessage(result.message)
      }
    })
  }, [selected])

  const bulkSendBack = useCallback((): void => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkPending(true)
    startTransition(async () => {
      const result = await actions.bulkSendBack(ids)
      setBulkPending(false)
      setSelected(new Set())
      setBulkMessage(result.ok ? null : result.message)
    })
  }, [selected])

  // The export download carries the tab's active search/filters (not the
  // page): the endpoints serve exactly the filtered catalog, in the
  // table's current sort order.
  const exportQuery = useMemo(() => {
    const params = new URLSearchParams({ sort: query.sort, dir: query.dir })
    if (query.search) params.set("search", query.search)
    if (query.status !== "all") params.set("status", query.status)
    if (query.confidence !== "all") params.set("confidence", query.confidence)
    return params.toString()
  }, [query])

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
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <select
          aria-label="Filter by status"
          className={SELECT_CLASS}
          value={query.status}
          onChange={(event) => changeFilter({ status: event.target.value })}
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
          value={query.confidence}
          onChange={(event) => changeFilter({ confidence: event.target.value })}
        >
          <option value="all">All confidence</option>
          <option value="low">Low (&lt;70)</option>
          <option value="medium">Medium (70–89)</option>
          <option value="high">High (90+)</option>
        </select>
        <select
          aria-label="Rows per page"
          className={SELECT_CLASS}
          value={query.pageSize}
          onChange={(event) => changeFilter({ pageSize: event.target.value })}
        >
          {PRODUCT_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
        <Button
          size="xs"
          disabled={selected.size === 0 || bulkPending}
          onClick={bulkApprove}
        >
          {bulkPending
            ? "Approving…"
            : `Approve selected (${approvedSelection > 0 ? approvedSelection : selected.size})`}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={selected.size === 0 || bulkPending}
          onClick={bulkSendBack}
        >
          {bulkPending
            ? "Sending back…"
            : `Send back selected (${selected.size})`}
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

      {bulkMessage ? (
        <Alert
          role="status"
          className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 [&>svg]:text-current"
        >
          <AlertDescription className="text-xs">{bulkMessage}</AlertDescription>
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
        <div
          className="flex min-w-0 flex-col gap-2"
          aria-busy={isPending || undefined}
        >
          {rows.length === 0 ? (
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
                        query.sort === column.key
                          ? query.dir === "asc"
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
                          {query.sort === column.key
                            ? query.dir === "asc"
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
                    onClick={() => updateQuery({ open: row.id })}
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
          {initial.total > 0 ? (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span suppressHydrationWarning>
                {((initial.page - 1) * initial.pageSize + 1).toLocaleString()}–
                {Math.min(
                  initial.page * initial.pageSize,
                  initial.total
                ).toLocaleString()}{" "}
                of {initial.total.toLocaleString()} products
              </span>
              <span className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={query.page <= 1}
                  onClick={() => updateQuery({ page: String(query.page - 1) })}
                >
                  Previous
                </Button>
                <span>
                  Page {initial.page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={query.page >= totalPages}
                  onClick={() => updateQuery({ page: String(query.page + 1) })}
                >
                  Next
                </Button>
              </span>
            </div>
          ) : null}
        </div>

        {openId ? (
          <div className="border border-border p-3">
            <ProductPanel
              product={detail}
              onClose={() => updateQuery({ open: undefined })}
              actions={actions}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
