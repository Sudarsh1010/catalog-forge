/**
 * Product page — one Publication snapshot in the country's locale, falling
 * back to English when the target locale has none. Reads Publications only
 * (ADR-0005); an unknown handle renders 404.
 */
import Link from "next/link"
import { notFound } from "next/navigation"

import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

import { CountrySwitcher } from "@/components/country-switcher"
import {
  getPublishedProduct,
  resolveLocale,
  searchParam,
  type StoreLocale,
} from "@/lib/storefront"
import { presignDownload } from "@/lib/storage"

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

export default async function StorefrontProductPage({
  params,
  searchParams,
}: PageProps<"/storefront/[handle]">) {
  const { handle } = await params
  const { country: rawCountry } = await searchParams
  const country = searchParam(rawCountry)
  const locale = resolveLocale(country)
  const product = await getPublishedProduct(handle, locale)

  if (!product) notFound()

  const price = formatPrice(product.priceCents, product.priceCurrency)
  // The union of attribute axes across variants drives the table columns.
  const variantAttributeKeys = [
    ...new Set(product.variants.flatMap((v) => Object.keys(v.attributes))),
  ]

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-col gap-2">
        <Link
          href={`/storefront${country ? `?country=${country}` : ""}`}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          ← All products
        </Link>
        <CountrySwitcher country={country} pathname={`/storefront/${handle}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{product.title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {product.category ? (
              <Badge variant="secondary">{product.category}</Badge>
            ) : null}
            {price ? (
              <span className="text-sm font-medium">{price}</span>
            ) : null}
            {product.fellBackToEnglish ? (
              <Badge variant="outline">
                {LOCALE_LABELS[product.resolvedLocale]}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {product.description ? (
            <p className="text-sm/relaxed whitespace-pre-line">
              {product.description}
            </p>
          ) : null}
          {product.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {product.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
          {product.photos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {await Promise.all(
                product.photos.map(async (photo) => (
                  <img
                    key={photo.objectKey}
                    src={await presignDownload(photo.objectKey)}
                    alt={photo.filename}
                    className="aspect-square w-full rounded-none object-cover ring-1 ring-foreground/10"
                    loading="lazy"
                  />
                ))
              )}
            </div>
          ) : null}

          {product.variants.length > 0 ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Variants</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      {variantAttributeKeys.map((key) => (
                        <TableHead key={key}>{key}</TableHead>
                      ))}
                      <TableHead className="text-right">Price</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variants.map((variant) => (
                      <TableRow key={variant.sku ?? variant.gtin ?? ""}>
                        <TableCell>{variant.sku ?? "—"}</TableCell>
                        {variantAttributeKeys.map((key) => (
                          <TableCell key={key}>
                            {variant.attributes[key] ?? "—"}
                          </TableCell>
                        ))}
                        <TableCell className="text-right">
                          {formatPrice(
                            variant.priceCents,
                            variant.priceCurrency
                          ) ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {Object.keys(product.attributes).length > 0 ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {Object.entries(product.attributes).map(([key, value]) => (
                <div key={key} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
