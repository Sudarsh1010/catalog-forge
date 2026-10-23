/**
 * UI-level test for the Products tab's export buttons (review finding):
 * the rendered anchors must build the format as a real path segment
 * (`/api/products/export/csv?…`), not append it after the query string —
 * the route-level suite could only 404-check the routes themselves, so
 * this is the seam that asserts what the browser actually requests.
 *
 * The component is a client component; we render it to static markup with
 * TanStack Query mocked out (the data path is covered by the route tests)
 * and assert the hrefs.
 */
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProductsTab } from "@/components/products-tab"

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol("keepPreviousData"),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQuery: () => ({ data: undefined, isPending: true, isError: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))

function hrefOf(markup: string, label: string): string {
  const anchor = markup
    .split("<a ")
    .find((chunk) => chunk.includes(`>${label}</a>`))
  expect(anchor, `an anchor labelled ${label}`).toBeDefined()
  return anchor!.match(/href="([^"]*)"/)![1]!
}

describe("ProductsTab export buttons", () => {
  it("renders the format as a path segment with the filters as the query", () => {
    const markup = renderToStaticMarkup(createElement(ProductsTab))

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
})
