/**
 * Catalog export downloads (ticket #18): the Products tab's active
 * search/filters as CSV or JSON. Lives outside the oRPC mount because a
 * download is a file response — attachment disposition and a document
 * content-type — not a JSON RPC payload. The filters reuse the
 * product.list read model verbatim (`loadProductExport`), so the file
 * holds exactly what the table shows, minus pagination.
 */
import {
  PRODUCT_CONFIDENCE_FILTERS,
  PRODUCT_SORTS,
  PRODUCT_STATUS_FILTERS,
  type ProductConfidenceFilter,
  type ProductSort,
  type ProductStatusFilter,
} from "@workspace/contracts"

import { catalogCsv, catalogJson } from "@/lib/catalog-export"
import { getDb } from "@/lib/db"
import { UUID_RE } from "@/lib/imports"
import { loadProductExport, type ProductCatalogQuery } from "@/lib/products"

export const runtime = "nodejs"

const CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
} as const

type ExportFormat = keyof typeof CONTENT_TYPES

function isOneOf<T extends string>(
  values: readonly T[],
  value: string
): value is T {
  return (values as readonly string[]).includes(value)
}

/**
 * The URL query — the same filter semantics as product.list, minus
 * pagination. Rejects unknown values with the same strictness the oRPC
 * input schema applies to the table.
 */
function parseExportQuery(
  searchParams: URLSearchParams
): { ok: true; query: ProductCatalogQuery } | { ok: false; message: string } {
  const search = searchParams.get("search") ?? undefined
  if (search !== undefined && search.length > 200) {
    return { ok: false, message: "search must be at most 200 characters." }
  }

  const status = searchParams.get("status") ?? "all"
  if (!isOneOf(PRODUCT_STATUS_FILTERS, status)) {
    return {
      ok: false,
      message: `status must be one of: ${PRODUCT_STATUS_FILTERS.join(", ")}.`,
    }
  }

  const confidence = searchParams.get("confidence") ?? "all"
  if (!isOneOf(PRODUCT_CONFIDENCE_FILTERS, confidence)) {
    return {
      ok: false,
      message: `confidence must be one of: ${PRODUCT_CONFIDENCE_FILTERS.join(", ")}.`,
    }
  }

  const sort = searchParams.get("sort") ?? "updatedAt"
  if (!isOneOf(PRODUCT_SORTS, sort)) {
    return {
      ok: false,
      message: `sort must be one of: ${PRODUCT_SORTS.join(", ")}.`,
    }
  }

  const dir = searchParams.get("dir") ?? "desc"
  if (dir !== "asc" && dir !== "desc") {
    return { ok: false, message: "dir must be asc or desc." }
  }

  const importId = searchParams.get("importId") ?? undefined
  if (importId !== undefined && !UUID_RE.test(importId)) {
    return { ok: false, message: "importId must be a UUID." }
  }

  return {
    ok: true,
    query: {
      sort: sort as ProductSort,
      dir,
      search,
      status: status as ProductStatusFilter,
      confidence: confidence as ProductConfidenceFilter,
      importId,
    },
  }
}

function errorResponse(
  message: string,
  status: number,
  code: string
): Response {
  return Response.json({ error: { message, code } }, { status })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ format: string }> }
): Promise<Response> {
  const { format } = await params
  if (format !== "csv" && format !== "json") {
    return new Response("Not Found", { status: 404 })
  }

  const parsed = parseExportQuery(new URL(request.url).searchParams)
  if (!parsed.ok) {
    return errorResponse(parsed.message, 400, "INVALID_EXPORT_QUERY")
  }

  const rows = await loadProductExport(getDb().db, parsed.query)
  const date = new Date().toISOString().slice(0, 10)
  return new Response(format === "csv" ? catalogCsv(rows) : catalogJson(rows), {
    headers: {
      "content-type": CONTENT_TYPES[format],
      "content-disposition": `attachment; filename="catalog-export-${date}.${format}"`,
      "cache-control": "no-store",
    },
  })
}
