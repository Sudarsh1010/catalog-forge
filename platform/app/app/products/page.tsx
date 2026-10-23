/**
 * The Products review tab (spec user stories 20–24, #11 server-driven
 * table): the RSC page runs the catalog query server-side — the same
 * `loadProductList`/`loadProductDetail` surface the oRPC procedures and
 * the Node-side tests use — so the initial table and the review panel
 * render in the SSR HTML. View state (page, sort, search, filters, the
 * open panel) lives in the query string, so every table interaction is a
 * server round-trip reflecting live pipeline state.
 */
import { DashboardNav } from "@/components/dashboard-nav"
import { ProductsTab } from "@/components/products-tab"
import {
  approveProductAction,
  bulkApproveProductsAction,
  bulkSendBackProductsAction,
  editProductAction,
  sendBackProductAction,
} from "./actions"
import { getDb } from "@/lib/db"
import {
  loadProductDetail,
  loadProductList,
  type ProductListQuery,
} from "@/lib/products"
import { UUID_RE } from "@/lib/imports"
import {
  PRODUCT_CONFIDENCE_FILTERS,
  PRODUCT_PAGE_SIZES,
  PRODUCT_SORTS,
  PRODUCT_STATUS_FILTERS,
  ProductConfidenceFilterSchema,
  ProductPageSizeSchema,
  ProductSortSchema,
  ProductStatusFilterSchema,
} from "@workspace/contracts"

export const dynamic = "force-dynamic"

type SearchParams = Record<string, string | string[] | undefined>

function single(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return first !== "" ? first : undefined
}

function numberIn(
  value: string | string[] | undefined,
  fallback: number
): number {
  const raw = single(value)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) ? parsed : fallback
}

/** Coerce query-string values onto the contract's query shape. */
function parseListQuery(searchParams: SearchParams): ProductListQuery {
  const page = Math.max(1, numberIn(searchParams.page, 1))
  const requestedSize = numberIn(searchParams.pageSize, 25)
  const pageSize = (PRODUCT_PAGE_SIZES as readonly number[]).includes(
    requestedSize
  )
    ? ProductPageSizeSchema.parse(requestedSize)
    : 25
  const sortRaw = single(searchParams.sort)
  const sort = PRODUCT_SORTS.includes(sortRaw as (typeof PRODUCT_SORTS)[number])
    ? ProductSortSchema.parse(sortRaw)
    : "updatedAt"
  const dir = single(searchParams.dir) === "asc" ? "asc" : "desc"
  const statusRaw = single(searchParams.status)
  const status = PRODUCT_STATUS_FILTERS.includes(
    statusRaw as (typeof PRODUCT_STATUS_FILTERS)[number]
  )
    ? ProductStatusFilterSchema.parse(statusRaw)
    : "all"
  const confidenceRaw = single(searchParams.confidence)
  const confidence = PRODUCT_CONFIDENCE_FILTERS.includes(
    confidenceRaw as (typeof PRODUCT_CONFIDENCE_FILTERS)[number]
  )
    ? ProductConfidenceFilterSchema.parse(confidenceRaw)
    : "all"
  const search = single(searchParams.q)
  return {
    page,
    pageSize,
    sort,
    dir,
    status,
    confidence,
    search: search !== undefined ? search.slice(0, 200) : undefined,
  }
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const query = parseListQuery(params)

  const open = single(params.open)
  const openId = open !== undefined && UUID_RE.test(open) ? open : undefined
  const db = getDb().db
  const [initial, openDetail] = await Promise.all([
    loadProductList(db, query),
    openId !== undefined
      ? loadProductDetail(db, openId)
      : Promise.resolve(null),
  ])

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <DashboardNav active="/products" />
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-lg font-medium">Products</h1>
          <p className="text-sm text-muted-foreground">
            Review the AI-built catalog: check every claim against its source
            row, edit what the model got wrong, and approve what ships.
          </p>
        </div>
      </header>
      <ProductsTab
        initial={initial}
        query={query}
        detail={openDetail}
        openId={openId}
        actions={{
          bulkApprove: bulkApproveProductsAction,
          bulkSendBack: bulkSendBackProductsAction,
          approve: approveProductAction,
          edit: editProductAction,
          sendBack: sendBackProductAction,
        }}
      />
    </div>
  )
}
