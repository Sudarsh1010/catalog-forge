/**
 * UI-level test for the Products tab (review finding): the tab is
 * server-driven now — the RSC page renders the table and this client
 * component receives the result as props, so `renderToStaticMarkup` with
 * real props is exactly the markup the server ships. The export anchors
 * must build the format as a real path segment
 * (`/api/products/export/csv?…`), not append it after the query string —
 * the route-level suite could only 404-check the routes themselves, so
 * this is the seam that asserts what the browser actually requests.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { ProductListResult } from "@workspace/contracts"
import type { ProductTabActions } from "@/app/products/actions"
import type { ProductListQuery } from "@/lib/products"

import { ProductsTab } from "@/components/products-tab"

const push = vi.fn()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}))

const ACTIONS: ProductTabActions = {
  bulkApprove: async () => ({ ok: true, approved: 0, skipped: [] }),
  bulkSendBack: async () => ({ ok: true, sentBack: 0 }),
  approve: async () => ({ ok: true, publishedLocales: ["en", "de", "fr"] }),
  edit: async () => ({ ok: true }),
  sendBack: async () => ({ ok: true }),
}

function row(
  id: string,
  title: string,
  status: ProductListResult["rows"][number]["status"]
): ProductListResult["rows"][number] {
  return {
    id,
    importId: "11111111-1111-4111-8111-111111111111",
    importFilename: "supplier-sheet.csv",
    naturalKey: `key-${id}`,
    title,
    handle: `handle-${id}`,
    status,
    reviewReasons: [],
    confidence: {},
    minConfidence: null,
    messiness: null,
    sourceRowCount: 1,
    photoCount: 0,
    editedByMerchant: false,
    publishedLocales: [],
    updatedAt: "2026-10-23T00:00:00.000Z",
  }
}

const RESULT: ProductListResult = {
  rows: [
    row("a", "Steel Toed Boots", "ready"),
    row("b", "Wool Socks", "approved"),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
}

const QUERY: ProductListQuery = {
  page: 1,
  pageSize: 25,
  sort: "updatedAt",
  dir: "desc",
  status: "all",
  confidence: "all",
  search: undefined,
}

function hrefOf(markup: string, label: string): string {
  const anchor = markup
    .split("<a ")
    .find((chunk) => chunk.includes(`>${label}</a>`))
  expect(anchor, `an anchor labelled ${label}`).toBeDefined()
  return anchor!.match(/href="([^"]*)"/)![1]!
}

describe("ProductsTab server-rendered output", () => {
  it("renders the table rows from the server result", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductsTab, {
        initial: RESULT,
        query: QUERY,
        detail: null,
        openId: undefined,
        actions: ACTIONS,
      })
    )

    // The SSR HTML carries the actual rows — no pending-only shell.
    expect(markup).toContain("Steel Toed Boots")
    expect(markup).toContain("Wool Socks")
    expect(markup).not.toContain('aria-busy="true"')
    expect(markup).not.toContain("No products match")
    // Page position and total render too.
    expect(markup).toContain("of 2 products")
  })

  it("renders the review panel from the server-loaded detail", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductsTab, {
        initial: RESULT,
        query: QUERY,
        detail: {
          id: "a",
          importId: "11111111-1111-4111-8111-111111111111",
          importFilename: "supplier-sheet.csv",
          naturalKey: "key-a",
          identityKind: "code",
          brand: null,
          gtin: null,
          createdAt: "2026-10-23T00:00:00.000Z",
          status: "ready",
          enrichment: null,
          sheetHeader: ["SKU", "Title"],
          sourceRows: [{ rowIndex: 1, cells: ["A1", "Steel Toed Boots"] }],
          variants: [],
          photos: [],
          translations: [],
          publication: null,
        },
        openId: "a",
        actions: ACTIONS,
      })
    )

    expect(markup).toContain("Source — sheet rows, variants, photos")
    expect(markup).toContain("Steel Toed Boots")
    expect(markup).toContain("Close review panel")
  })

  it("renders the empty state when the server found no rows", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductsTab, {
        initial: { rows: [], total: 0, page: 1, pageSize: 25 },
        query: QUERY,
        detail: null,
        openId: undefined,
        actions: ACTIONS,
      })
    )

    expect(markup).toContain("No products match")
  })
})

describe("ProductsTab export buttons", () => {
  it("renders the format as a path segment with the filters as the query", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductsTab, {
        initial: RESULT,
        query: QUERY,
        detail: null,
        openId: undefined,
        actions: ACTIONS,
      })
    )

    const csv = hrefOf(markup, "Export CSV")
    const json = hrefOf(markup, "Export JSON")

    // The default sort rides along; the format is a path segment BEFORE
    // the query string, so the [format] route actually matches.
    expect(csv).toMatch(/^\/api\/products\/export\/csv\?/)
    expect(csv).toContain("sort=updatedAt")
    expect(csv).toContain("dir=desc")
    expect(json).toMatch(/^\/api\/products\/export\/json\?/)
    // The format must never dangle after the query string (the old bug:
    // `/api/products/export?sort=…/csv` 404s).
    expect(csv).not.toMatch(/\?.*\/csv/)
    expect(json).not.toMatch(/\?.*\/json/)
  })

  it("carries the active search and filters into the export query", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductsTab, {
        initial: RESULT,
        query: {
          ...QUERY,
          sort: "title",
          dir: "asc",
          search: "steel",
          status: "ready",
          confidence: "high",
        },
        detail: null,
        openId: undefined,
        actions: ACTIONS,
      })
    )

    const csv = hrefOf(markup, "Export CSV")
    expect(csv).toContain("sort=title")
    expect(csv).toContain("dir=asc")
    expect(csv).toContain("search=steel")
    expect(csv).toContain("status=ready")
    expect(csv).toContain("confidence=high")
  })
})

describe("ProductsTab bulk bar", () => {
  it("renders the Send back button next to Approve with the same selection rules", () => {
    const markup = renderToStaticMarkup(
      createElement(ProductsTab, {
        initial: RESULT,
        query: QUERY,
        detail: null,
        openId: undefined,
        actions: ACTIONS,
      })
    )

    // With nothing selected, both bulk actions render disabled — the
    // send-back button obeys exactly the approve button's empty rule.
    const approve = markup
      .split("<button")
      .find((chunk) => chunk.includes("Approve selected (0)"))
    expect(approve).toBeDefined()
    expect(approve!).toContain("disabled")

    const sendBack = markup
      .split("<button")
      .find((chunk) => chunk.includes("Send back selected (0)"))
    expect(sendBack).toBeDefined()
    expect(sendBack!).toContain("disabled")
  })
})
