/**
 * Storefront routes — collection + product pages over plain HTTP against a
 * real `next dev` (the web seam).
 *
 * The storefront must read Publications ONLY (ADR-0005): approved products
 * are visible because approval wrote a Publication, under-review/staging
 * products are invisible by construction, and a country whose locale has
 * no snapshot falls back to the English one per Product.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import { publications } from "@workspace/db/schema"

import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  startTestApp,
  truncateTables,
  type TestApp,
} from "./helpers"

let app: TestApp
let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  app = await startTestApp()
})

beforeEach(async () => {
  await truncateTables(db)
})

afterAll(async () => {
  await app.close()
  await db.close()
  await dropTestDatabase()
})

const keyHash = (key: string): string =>
  createHash("sha256").update(key, "utf8").digest("hex")

async function seedImport(): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO imports (
      id, store_id, content_hash, family_key, original_filename, sheet_format,
      sheet_object_key, status, stage, sheet_header
    ) VALUES (
      ${id}, 'default', ${crypto.randomUUID().replaceAll("-", "")},
      'supplier-sheet.csv', 'supplier-sheet.csv', 'csv', 'imports/default/x/sheet.csv',
      'completed', 'finalise', ${JSON.stringify(["SKU", "Title"])}::jsonb
    )
  `)
  return id
}

async function seedProduct(importId: string, title: string): Promise<string> {
  const id = crypto.randomUUID()
  const naturalKey = `title:${title.toLowerCase()}`
  await db.db.execute(sql`
    INSERT INTO products (
      id, store_id, import_id, family_key, identity_kind, natural_key,
      natural_key_hash, title, needs_review
    ) VALUES (
      ${id}, 'default', ${importId}, 'supplier-sheet.csv', 'title', ${naturalKey},
      ${keyHash(naturalKey)}, ${title}, false
    )
  `)
  return id
}

interface SeedPublicationOptions {
  productId: string
  handle: string
  locale: "en" | "de" | "fr"
  title: string
  description?: string
  category?: string
  priceCents?: number
  priceCurrency?: string
  variants?: Array<{
    sku: string | null
    gtin: string | null
    priceCents: number | null
    priceCurrency: string | null
    attributes: Record<string, string>
    imageRef: string | null
  }>
  photos?: Array<{ objectKey: string; filename: string }>
}

async function seedPublication(options: SeedPublicationOptions): Promise<void> {
  await db.db.insert(publications).values({
    storeId: "default",
    productId: options.productId,
    locale: options.locale,
    handle: options.handle,
    title: options.title,
    description: options.description ?? "",
    category: options.category ?? "",
    priceCents: options.priceCents ?? null,
    priceCurrency: options.priceCurrency ?? null,
    variants: options.variants ?? [],
    photos: options.photos ?? [],
  })
}

/** A translated product (en + de), an English-only one, an unpublished one. */
async function seedCatalog(): Promise<{
  translatedHandle: string
  englishOnlyHandle: string
  unpublishedTitle: string
}> {
  const importId = await seedImport()

  const translatedId = await seedProduct(importId, "Watering can 5 l")
  await seedPublication({
    productId: translatedId,
    handle: "watering-can-5-l",
    locale: "en",
    title: "Watering can 5 l",
    description: "A sturdy galvanised watering can.",
    category: "Garden",
    priceCents: 1299,
    priceCurrency: "EUR",
    variants: [
      {
        sku: "WC-5-RED",
        gtin: null,
        priceCents: 1299,
        priceCurrency: "EUR",
        attributes: { Colour: "Red" },
        imageRef: "kanne.jpg",
      },
      {
        sku: "WC-5-BLU",
        gtin: null,
        priceCents: 1299,
        priceCurrency: "EUR",
        attributes: { Colour: "Blue" },
        imageRef: null,
      },
    ],
    photos: [
      {
        objectKey: "imports/default/x/photos/kanne.jpg",
        filename: "kanne.jpg",
      },
    ],
  })
  await seedPublication({
    productId: translatedId,
    handle: "watering-can-5-l",
    locale: "de",
    title: "Gießkanne 5 l",
    description: "Eine stabile verzinkte Gießkanne.",
    category: "Garten",
    priceCents: 1299,
    priceCurrency: "EUR",
    variants: [
      {
        sku: "WC-5-RED",
        gtin: null,
        priceCents: 1299,
        priceCurrency: "EUR",
        attributes: { Colour: "Rot" },
        imageRef: "kanne.jpg",
      },
      {
        sku: "WC-5-BLU",
        gtin: null,
        priceCents: 1299,
        priceCurrency: "EUR",
        attributes: { Colour: "Blau" },
        imageRef: null,
      },
    ],
    photos: [
      {
        objectKey: "imports/default/x/photos/kanne.jpg",
        filename: "kanne.jpg",
      },
    ],
  })

  const englishOnlyId = await seedProduct(importId, "Garden hose 20 m")
  await seedPublication({
    productId: englishOnlyId,
    handle: "garden-hose-20-m",
    locale: "en",
    title: "Garden hose 20 m",
    description: "A long flexible garden hose.",
    category: "Garden",
    priceCents: 2499,
    priceCurrency: "EUR",
  })

  // A Product that exists in staging but was never approved.
  await seedProduct(importId, "Secret unpublished widget")

  return {
    translatedHandle: "watering-can-5-l",
    englishOnlyHandle: "garden-hose-20-m",
    unpublishedTitle: "Secret unpublished widget",
  }
}

describe("GET /storefront (collection)", () => {
  it("returns 200 and an empty state on a fresh catalog", async () => {
    const res = await fetch(`${app.baseUrl}/storefront`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("All products")
    expect(html).toContain("Nothing published yet")
  })

  it("lists published products with German copy for Germany and Austria", async () => {
    const { translatedHandle, englishOnlyHandle, unpublishedTitle } =
      await seedCatalog()

    for (const country of ["DE", "AT"]) {
      const res = await fetch(`${app.baseUrl}/storefront?country=${country}`)
      expect(res.status).toBe(200)
      const html = await res.text()
      // Localized title for the translated product…
      expect(html).toContain("Gießkanne 5 l")
      expect(html).not.toContain("Watering can 5 l")
      // …and English fallback for the English-only product.
      expect(html).toContain("Garden hose 20 m")
      // Both approved products link to their pages.
      expect(html).toContain(`/storefront/${translatedHandle}`)
      expect(html).toContain(`/storefront/${englishOnlyHandle}`)
      // Staging-only products are invisible by construction (ADR-0005).
      expect(html).not.toContain(unpublishedTitle)
    }
  })

  it("renders French for France and English for everyone else", async () => {
    await seedCatalog()

    const fr = await fetch(`${app.baseUrl}/storefront?country=FR`)
    expect(fr.status).toBe(200)
    // France has no French snapshot yet — every product falls back to English.
    expect(await fr.text()).toContain("Watering can 5 l")

    for (const query of ["", "?country=GB", "?country=US", "?country=XX"]) {
      const res = await fetch(`${app.baseUrl}/storefront${query}`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("Watering can 5 l")
      expect(html).not.toContain("Gießkanne 5 l")
    }
  })
})

describe("GET /storefront/[handle] (product)", () => {
  it("returns 200 with the localized snapshot for Germany", async () => {
    const { translatedHandle } = await seedCatalog()

    const res = await fetch(
      `${app.baseUrl}/storefront/${translatedHandle}?country=DE`
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Gießkanne 5 l")
    expect(html).toContain("Eine stabile verzinkte Gießkanne.")
    expect(html).toContain("Garten")
    expect(html).not.toContain("Watering can 5 l")
    // The render-ready snapshot carries Variants and photos.
    expect(html).toContain("WC-5-RED")
    expect(html).toContain("WC-5-BLU")
    expect(html).toContain("Colour")
    expect(html).toContain("kanne.jpg")
  })

  it("falls back to the English snapshot when the locale is missing", async () => {
    const { translatedHandle, englishOnlyHandle } = await seedCatalog()

    // The translated product has no French snapshot yet.
    const fr = await fetch(
      `${app.baseUrl}/storefront/${translatedHandle}?country=FR`
    )
    expect(fr.status).toBe(200)
    const frHtml = await fr.text()
    expect(frHtml).toContain("Watering can 5 l")
    expect(frHtml).toContain("A sturdy galvanised watering can.")
    expect(frHtml).toContain("English")

    // The English-only product falls back under German too.
    const de = await fetch(
      `${app.baseUrl}/storefront/${englishOnlyHandle}?country=DE`
    )
    expect(de.status).toBe(200)
    const deHtml = await de.text()
    expect(deHtml).toContain("Garden hose 20 m")
    expect(deHtml).toContain("A long flexible garden hose.")
    expect(deHtml).toContain("English")
  })

  it("serves the English snapshot without a country", async () => {
    const { translatedHandle } = await seedCatalog()

    const res = await fetch(`${app.baseUrl}/storefront/${translatedHandle}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Watering can 5 l")
    expect(html).toContain("A sturdy galvanised watering can.")
  })

  it("returns 404 for an unknown handle", async () => {
    await seedCatalog()
    const res = await fetch(`${app.baseUrl}/storefront/no-such-handle`)
    expect(res.status).toBe(404)
  })
})
