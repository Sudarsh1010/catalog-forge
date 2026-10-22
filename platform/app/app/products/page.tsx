/**
 * The Products review tab (spec user stories 20–24): the catalog table with
 * pagination/sort/search/filters and the side-by-side review panel. Reads
 * and writes go through the oRPC `product` namespace (ADR-0004); approval
 * writes Publications (ADR-0005).
 */
import { DashboardNav } from "@/components/dashboard-nav"
import { ProductsTab } from "@/components/products-tab"

export default function ProductsPage() {
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
      <ProductsTab />
    </div>
  )
}
