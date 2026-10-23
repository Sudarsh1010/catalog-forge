/**
 * Storefront read model — Publications ONLY (ADR-0005).
 *
 * Every query here touches the `publications` table alone: no staging
 * tables, no worker/queue tables, no AI calls. A Publication's existence
 * IS approval, so "only approved products are visible" holds by
 * construction rather than by filter.
 *
 * Locale resolution follows the country switcher contract: Germany and
 * Austria read German, France reads French, everyone else reads English.
 * A missing target-locale Publication falls back to the English one per
 * Product — the English snapshot is always the source of truth.
 */
import { and, asc, eq, inArray } from "drizzle-orm"

import { publications } from "@workspace/db/schema"
import {
  DEFAULT_STORE_ID,
  SOURCE_LOCALE,
  type TargetLocale,
} from "@workspace/pipeline"

import { getDb } from "./db"

/** The countries the switcher offers; anything unlisted reads English. */
export const COUNTRY_LOCALES: Record<string, TargetLocale> = {
  DE: "de",
  AT: "de",
  FR: "fr",
}

export type StoreLocale = typeof SOURCE_LOCALE | TargetLocale

export const COUNTRIES = ["DE", "AT", "FR", "GB"] as const
export type Country = (typeof COUNTRIES)[number]

export const COUNTRY_LABELS: Record<Country, string> = {
  DE: "Germany",
  AT: "Austria",
  FR: "France",
  GB: "United Kingdom",
}

/** Country → locale: DE/AT → German, FR → French, everything else English. */
export function resolveLocale(country?: string | null): StoreLocale {
  return country
    ? (COUNTRY_LOCALES[country.toUpperCase()] ?? SOURCE_LOCALE)
    : SOURCE_LOCALE
}

/**
 * One searchParams value: Next hands repeated keys back as arrays, so the
 * storefront pages take the first occurrence instead of coercing inline.
 */
export function searchParam(value?: string | string[]): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export type StorefrontCard = {
  handle: string
  title: string
  category: string
  priceCents: number | null
  priceCurrency: string | null
}

/**
 * The collection listing: every approved Product in the requested locale.
 * Products published only in English keep their English copy when the
 * requested locale has no snapshot yet.
 */
export async function listPublishedProducts(
  locale: StoreLocale
): Promise<StorefrontCard[]> {
  const db = getDb()
  const base = db.db
    .select({
      productId: publications.productId,
      handle: publications.handle,
      title: publications.title,
      category: publications.category,
      priceCents: publications.priceCents,
      priceCurrency: publications.priceCurrency,
    })
    .from(publications)
    .where(
      and(
        eq(publications.storeId, DEFAULT_STORE_ID),
        eq(publications.locale, SOURCE_LOCALE)
      )
    )
    .orderBy(asc(publications.title))

  if (locale === SOURCE_LOCALE) {
    return base
  }

  const english = await base
  if (english.length === 0) return []

  const localized = await db.db
    .select({
      productId: publications.productId,
      handle: publications.handle,
      title: publications.title,
      category: publications.category,
      priceCents: publications.priceCents,
      priceCurrency: publications.priceCurrency,
    })
    .from(publications)
    .where(
      and(
        eq(publications.storeId, DEFAULT_STORE_ID),
        eq(publications.locale, locale),
        inArray(
          publications.productId,
          english.map((row) => row.productId)
        )
      )
    )

  const byProduct = new Map(localized.map((row) => [row.productId, row]))
  return english.map((row) => byProduct.get(row.productId) ?? row)
}

export type StorefrontVariant = {
  sku: string | null
  gtin: string | null
  priceCents: number | null
  priceCurrency: string | null
  attributes: Record<string, string>
  imageRef: string | null
}

export type StorefrontPhoto = { objectKey: string; filename: string }

export type StorefrontProduct = StorefrontCard & {
  description: string
  tags: string[]
  attributes: Record<string, string>
  variants: StorefrontVariant[]
  photos: StorefrontPhoto[]
  /** The locale actually rendered — set when a translation was missing. */
  resolvedLocale: StoreLocale
  /** True when the requested locale had no Publication and English won. */
  fellBackToEnglish: boolean
}

/**
 * One Product page snapshot in the requested locale, falling back to the
 * English Publication when the target locale has none. Returns `null` for
 * unknown handles (the caller renders 404).
 */
export async function getPublishedProduct(
  handle: string,
  locale: StoreLocale
): Promise<StorefrontProduct | null> {
  const db = getDb()
  const whereStore = and(
    eq(publications.storeId, DEFAULT_STORE_ID),
    eq(publications.handle, handle)
  )

  const columns = {
    productId: publications.productId,
    handle: publications.handle,
    title: publications.title,
    description: publications.description,
    category: publications.category,
    tags: publications.tags,
    attributes: publications.attributes,
    variants: publications.variants,
    photos: publications.photos,
    priceCents: publications.priceCents,
    priceCurrency: publications.priceCurrency,
    locale: publications.locale,
  }

  const [requested] = await db.db
    .select(columns)
    .from(publications)
    .where(and(whereStore, eq(publications.locale, locale)))
    .limit(1)

  if (requested) {
    return { ...requested, resolvedLocale: locale, fellBackToEnglish: false }
  }

  const [english] = await db.db
    .select(columns)
    .from(publications)
    .where(and(whereStore, eq(publications.locale, SOURCE_LOCALE)))
    .limit(1)

  if (!english) return null
  return {
    ...english,
    resolvedLocale: SOURCE_LOCALE,
    fellBackToEnglish: locale !== SOURCE_LOCALE,
  }
}
