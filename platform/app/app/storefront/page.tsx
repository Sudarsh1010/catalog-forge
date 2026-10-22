/**
 * Collection page — every approved Product, one Publication snapshot per
 * Product per locale (ADR-0005). Reads Publications only; Products still
 * under review are invisible because their approval never wrote one.
 */
import Link from "next/link"

import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

import { CountrySwitcher } from "@/components/country-switcher"
import {
  listPublishedProducts,
  resolveLocale,
  type StoreLocale,
} from "@/lib/storefront"

export const metadata = { title: "CatalogForge Store" }

const LOCALE_LABELS: Record<StoreLocale, string> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
}

function formatPrice(
  cents: number | null,
  currency: string | null
): string | null {
  if (cents === null || !currency) return null
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(cents / 100)
}

export default async function StorefrontCollectionPage({
  searchParams,
}: PageProps<"/storefront">) {
  const { country } = await searchParams
  const locale = resolveLocale(country)
  const products = await listPublishedProducts(locale)

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-lg font-medium">All products</h1>
        <CountrySwitcher country={country} pathname="/storefront" />
        <p className="text-xs text-muted-foreground">
          {LOCALE_LABELS[locale]} · {products.length}{" "}
          {products.length === 1 ? "product" : "products"}
        </p>
      </div>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing published yet. Approved products appear here.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {products.map((product) => {
            const price = formatPrice(product.priceCents, product.priceCurrency)
            return (
              <li key={product.handle}>
                <Link
                  href={`/storefront/${product.handle}${country ? `?country=${country}` : ""}`}
                  className="block h-full"
                >
                  <Card
                    size="sm"
                    className="h-full transition-colors hover:bg-foreground/5"
                  >
                    <CardHeader>
                      <CardTitle>{product.title}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap items-center gap-2">
                      {product.category ? (
                        <Badge variant="secondary">{product.category}</Badge>
                      ) : null}
                      {price ? <span className="text-xs">{price}</span> : null}
                    </CardContent>
                  </Card>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
