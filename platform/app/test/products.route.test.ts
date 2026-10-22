/**
 * Products-tab procedures — via the typed oRPC client against a real
 * `next dev` (RPC mount at /api/rpc).
 *
 * Covers the review tab's HTTP seam end to end: server-driven pagination
 * (10/25/50/100), sort, search and filters with per-field Confidence in
 * the payload; the side-by-side detail (source rows + photos vs AI result
 * with claim pointers); merchant edits storing Origin; approve and bulk
 * approve writing Publications (ADR-0005); send-back retracting them and
 * writing the Re-run FACT (ADR-0004). Enrichments are seeded exactly in
 * the shape the Demo Mode stub writes (worker suite covers the writer).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import { createORPCClient, isDefinedError, ORPCError, safe } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import type { ClientContract } from "@workspace/contracts"

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
let client: ClientContract

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  app = await startTestApp()
  client = createORPCClient(new RPCLink({ url: `${app.baseUrl}/api/rpc` }))
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
      sheet_object_key, status, stage, row_count, sheet_header
    ) VALUES (
      ${id}, 'default', ${crypto.randomUUID().replaceAll("-", "")},
      'supplier-sheet.csv', 'supplier-sheet.csv', 'csv', 'imports/default/x/sheet.csv',
      'completed', 'finalise', 12,
      ${JSON.stringify([
        "SKU",
        "Title",
        "Brand",
        "Category",
        "Description",
        "Price",
      ])}::jsonb
    )
  `)
  return id
}

async function seedSheetRow(
  importId: string,
  rowIndex: number,
  cells: Array<string | number | null>
): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO sheet_rows (store_id, import_id, row_index, raw)
    VALUES ('default', ${importId}, ${rowIndex}, ${JSON.stringify(cells)}::jsonb)
  `)
}

interface SeedProductOptions {
  brand?: string | null
  needsReview?: boolean
  reviewReason?: string | null
}

async function seedProduct(
  importId: string,
  naturalKey: string,
  options: SeedProductOptions = {}
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO products (
      id, store_id, import_id, identity_kind, natural_key,
      natural_key_hash, title, brand, needs_review, review_reason
    ) VALUES (
      ${id}, 'default', ${importId}, 'code', ${naturalKey},
      ${keyHash(naturalKey)}, ${`Raw ${naturalKey}`}, ${options.brand ?? null},
      ${options.needsReview ?? false}, ${options.reviewReason ?? null}
    )
  `)
  return id
}

interface SeedEnrichmentOptions {
  title?: string
  handle?: string
  description?: string
  category?: string
  tags?: string[]
  attributes?: Record<string, string>
  confidence?: Record<string, number>
  status?: "ready" | "needs_review"
  claims?: Array<{ text: string; sourceRowIndex: number }>
  reviewReasons?: string[]
  sourceRowIndexes?: number[]
  fieldOrigins?: Record<string, string>
  messiness?: number
}

const GROUNDED_CONFIDENCE = {
  title: 95,
  handle: 95,
  description: 90,
  category: 90,
  tags: 80,
  attributes: 90,
}

/** Everything ≥ 90 — the green bucket the stub's cleanest rows approach. */
const HIGH_CONFIDENCE = {
  title: 95,
  handle: 95,
  description: 92,
  category: 92,
  tags: 90,
  attributes: 90,
}

async function seedEnrichment(
  importId: string,
  productId: string,
  options: SeedEnrichmentOptions = {}
): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO product_enrichments (
      store_id, import_id, product_id, title, handle, description, category,
      tags, attributes, confidence, status, claims, review_reasons,
      source_row_indexes, field_origins, messiness
    ) VALUES (
      'default', ${importId}, ${productId},
      ${options.title ?? `Enriched ${productId.slice(0, 4)}`},
      ${options.handle ?? `handle-${productId.slice(0, 8)}`},
      ${options.description ?? "A solid product."},
      ${options.category ?? "Garden > Tools"},
      ${JSON.stringify(options.tags ?? ["garden"])}::jsonb,
      ${JSON.stringify(options.attributes ?? { Colour: "red" })}::jsonb,
      ${JSON.stringify(options.confidence ?? GROUNDED_CONFIDENCE)}::jsonb,
      ${options.status ?? "ready"},
      ${JSON.stringify(options.claims ?? [])}::jsonb,
      ${JSON.stringify(options.reviewReasons ?? [])}::jsonb,
      ${JSON.stringify(options.sourceRowIndexes ?? [1])}::jsonb,
      ${JSON.stringify(options.fieldOrigins ?? {})}::jsonb,
      ${options.messiness ?? 20}
    )
  `)
}

interface SeedVariantOptions {
  sku?: string | null
  priceCents?: number | null
  attributes?: Record<string, string>
  sourceRowIndex?: number
}

async function seedVariant(
  productId: string,
  variantKey: string,
  options: SeedVariantOptions = {}
): Promise<string> {
  const rows = (await db.db.execute(sql`
    INSERT INTO variants (
      store_id, import_id, product_id, variant_key, variant_key_hash,
      sku, price_cents, price_currency, attributes, source_row_index
    )
    SELECT 'default', p.import_id, p.id, ${variantKey}, ${keyHash(variantKey)},
           ${options.sku ?? null}, ${options.priceCents ?? null}, 'EUR',
           ${JSON.stringify(options.attributes ?? {})}::jsonb,
           ${options.sourceRowIndex ?? 1}
    FROM products p WHERE p.id = ${productId}
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

async function seedPhoto(
  importId: string,
  productId: string,
  filename: string
): Promise<string> {
  const fileId = crypto.randomUUID()
  const objectKey = `imports/default/x/${filename}`
  await db.db.execute(sql`
    INSERT INTO import_files (id, store_id, import_id, kind, object_key, filename, content_type)
    VALUES (${fileId}, 'default', ${importId}, 'photo', ${objectKey}, ${filename}, 'image/jpeg')
  `)
  await db.db.execute(sql`
    INSERT INTO product_photos (
      store_id, import_id, import_file_id, product_id, matched_via, matched_token
    ) VALUES (
      'default', ${importId}, ${fileId}, ${productId}, 'sku', ${filename.split(".")[0]}
    )
  `)
  return fileId
}

async function seedTranslation(
  productId: string,
  locale: string,
  field: string,
  text: string,
  origin: "ai" | "manual" = "ai",
  outOfDate = false
): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO product_translations (
      store_id, import_id, product_id, locale, field, text,
      source_text_hash, origin, out_of_date
    )
    SELECT 'default', p.import_id, p.id, ${locale}, ${field}, ${text},
           ${keyHash(text)}, ${origin}, ${outOfDate}
    FROM products p WHERE p.id = ${productId}
  `)
}

/**
 * The catalog scenario: 12 Products — 10 enriched (a high-confidence
 * ready one, a medium one, a low-confidence needs-review one with a claim
 * and a merchant edit, plus seven more ready ones), 2 pending — with a
 * two-variant priced Product, a photo, and de/fr translations.
 */
async function seedCatalog(): Promise<{
  importId: string
  high: string
  medium: string
  low: string
  pending: string
  priced: string
}> {
  const importId = await seedImport()
  for (let index = 1; index <= 12; index++) {
    await seedSheetRow(importId, index, [
      `SKU-${index}`,
      `Row title ${index}`,
      "Brunner",
      "Garden",
      "Row description",
      "12,50",
    ])
  }

  const high = await seedProduct(importId, "sku:high-1", { brand: "Brunner" })
  await seedEnrichment(importId, high, {
    title: "Brunner Gießkanne 5L",
    handle: "brunner-giesskanne-5l-abcdef12",
    confidence: HIGH_CONFIDENCE,
    sourceRowIndexes: [1, 2],
    claims: [
      { text: "frost-resistant", sourceRowIndex: 1 },
      { text: "5 litre capacity", sourceRowIndex: 2 },
    ],
  })
  const medium = await seedProduct(importId, "sku:medium-1")
  await seedEnrichment(importId, medium, {
    title: "Schaufel mittel",
    handle: "schaufel-mittel-12345678",
    confidence: { ...GROUNDED_CONFIDENCE, description: 75, tags: 70 },
  })
  const low = await seedProduct(importId, "sku:low-1", {
    needsReview: true,
    reviewReason: "Low-confidence enrichment: description 40 < 70.",
  })
  await seedEnrichment(importId, low, {
    title: "Blumentopf arm",
    handle: "blumentopf-arm-87654321",
    description: "Details: Diameter 20",
    category: "",
    confidence: {
      title: 95,
      handle: 95,
      description: 40,
      category: 60,
      tags: 80,
      attributes: 90,
    },
    status: "needs_review",
    reviewReasons: [
      "description: no source description — composed from attributes (confidence 40 < 70).",
      "category: no source category to ground the field (confidence 60 < 70).",
    ],
    sourceRowIndexes: [3],
    claims: [{ text: "diameter 20 cm", sourceRowIndex: 3 }],
  })
  const priced = await seedProduct(importId, "sku:priced-1")
  await seedEnrichment(importId, priced, {
    title: "Gießkanne priced",
    confidence: HIGH_CONFIDENCE,
  })
  await seedVariant(priced, "sku:priced-1-r", {
    sku: "PRICED-1-R",
    priceCents: 1250,
    attributes: { Farbe: "rot" },
  })
  await seedVariant(priced, "sku:priced-1-g", {
    sku: "PRICED-1-G",
    priceCents: 990,
    attributes: { Farbe: "grün" },
  })
  await seedPhoto(importId, priced, "priced-1.jpg")
  await seedTranslation(priced, "de", "title", "Brunner Gießkanne 5 Liter")
  await seedTranslation(priced, "de", "description", "Robuste Gießkanne.")
  await seedTranslation(priced, "fr", "title", "Arrosoir Brunner 5 L")

  // Seven more ready rows so pagination has pages, plus two pending.
  for (let index = 0; index < 7; index++) {
    const filler = await seedProduct(importId, `sku:filler-${index}`)
    await seedEnrichment(importId, filler, {
      title: `Filler product ${index}`,
      handle: `filler-product-${index}`,
      confidence: HIGH_CONFIDENCE,
      messiness: 30 + index,
    })
  }
  const pending = await seedProduct(importId, "sku:pending-1")

  return { importId, high, medium, low, pending, priced }
}

describe("product.list (the review tab table)", () => {
  it("paginates with the total riding beside the rows", async () => {
    await seedCatalog()
    const page1 = await client.product.list({
      page: 1,
      pageSize: 10,
      sort: "title",
      dir: "asc",
      status: "all",
      confidence: "all",
    })
    expect(page1.rows).toHaveLength(10)
    expect(page1.total).toBe(12)
    expect(page1.pageSize).toBe(10)
    const page2 = await client.product.list({
      page: 2,
      pageSize: 10,
      sort: "title",
      dir: "asc",
      status: "all",
      confidence: "all",
    })
    expect(page2.rows).toHaveLength(2)
    const page1Titles = page1.rows.map((row) => row.title)
    expect(
      page2.rows
        .map((row) => row.title)
        .every((title) => !page1Titles.includes(title))
    ).toBe(true)
  })

  it("rejects page sizes outside 10/25/50/100", async () => {
    await seedCatalog()
    const [error] = await safe(
      client.product.list({
        page: 1,
        pageSize: 30,
        sort: "title",
        dir: "asc",
        status: "all",
        confidence: "all",
      })
    )
    expect(isDefinedError(error)).toBe(false)
    expect((error as ORPCError<string, unknown>).status).toBeGreaterThanOrEqual(
      400
    )
  })

  it("sorts by title in both directions", async () => {
    await seedCatalog()
    const asc = await client.product.list({
      page: 1,
      pageSize: 10,
      sort: "title",
      dir: "asc",
      status: "all",
      confidence: "all",
    })
    const titles = asc.rows.map((row) => row.title)
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)))
    expect(titles[0]).toBe("Blumentopf arm")
    const desc = await client.product.list({
      page: 1,
      pageSize: 10,
      sort: "title",
      dir: "desc",
      status: "all",
      confidence: "all",
    })
    expect(desc.rows.map((row) => row.title)[0]).toBe("Schaufel mittel")
  })

  it("searches titles, handles and natural keys", async () => {
    await seedCatalog()
    const byTitle = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "all",
      search: "gießkanne",
    })
    expect(byTitle.rows.map((row) => row.title).sort()).toEqual([
      "Brunner Gießkanne 5L",
      "Gießkanne priced",
    ])
    const byKey = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "all",
      search: "sku:low-1",
    })
    expect(byKey.rows).toHaveLength(1)
    expect(byKey.rows[0]!.naturalKey).toBe("sku:low-1")
    const byHandle = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "all",
      search: "filler-product-3",
    })
    expect(byHandle.rows).toHaveLength(1)
  })

  it("filters by derived status, including approved via Publications", async () => {
    const { high, low, pending } = await seedCatalog()
    await client.product.approve({ id: high })
    const approved = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "approved",
      confidence: "all",
    })
    expect(approved.total).toBe(1)
    expect(approved.rows[0]!.id).toBe(high)
    expect(approved.rows[0]!.publishedLocales).toEqual(["en", "de", "fr"])

    const needsReview = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "needs_review",
      confidence: "all",
    })
    expect(needsReview.total).toBe(1)
    expect(needsReview.rows[0]!.id).toBe(low)

    const ready = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "ready",
      confidence: "all",
    })
    expect(ready.total).toBe(9)

    const pendingList = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "pending",
      confidence: "all",
    })
    expect(pendingList.total).toBe(1)
    expect(pendingList.rows[0]!.id).toBe(pending)
    expect(pendingList.rows[0]!.confidence).toEqual({})
    expect(pendingList.rows[0]!.minConfidence).toBeNull()
  })

  it("filters by the confidence buckets the colours encode", async () => {
    await seedCatalog()
    const low = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "low",
    })
    expect(low.rows.map((row) => row.naturalKey)).toEqual(["sku:low-1"])
    expect(low.rows[0]!.minConfidence).toBe(40)

    const medium = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "medium",
    })
    expect(medium.rows.map((row) => row.naturalKey)).toEqual(["sku:medium-1"])

    const high = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "high",
    })
    expect(high.total).toBe(9)
  })

  it("carries per-field Confidence and photo counts in every row", async () => {
    const { priced } = await seedCatalog()
    const list = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "all",
    })
    const row = list.rows.find((entry) => entry.id === priced)!
    expect(row.confidence).toMatchObject(HIGH_CONFIDENCE)
    expect(row.minConfidence).toBe(90)
    expect(row.photoCount).toBe(1)
    expect(row.importFilename).toBe("supplier-sheet.csv")
    expect(row.sourceRowCount).toBe(1)
  })
})

describe("product.detail (the side-by-side hydration)", () => {
  it("returns source rows, photos and variants next to the AI result with claim pointers", async () => {
    const { priced, low } = await seedCatalog()
    const detail = await client.product.detail({ id: priced })
    const product = detail.product
    expect(product.naturalKey).toBe("sku:priced-1")
    expect(product.enrichment!.title).toBe("Gießkanne priced")
    expect(product.sheetHeader).toEqual([
      "SKU",
      "Title",
      "Brand",
      "Category",
      "Description",
      "Price",
    ])
    expect(product.sourceRows).toHaveLength(1)
    expect(product.sourceRows[0]!.rowIndex).toBe(1)
    expect(product.sourceRows[0]!.cells[0]).toBe("SKU-1")
    expect(product.variants).toHaveLength(2)
    expect(product.variants.map((variant) => variant.sku).sort()).toEqual([
      "PRICED-1-G",
      "PRICED-1-R",
    ])
    expect(product.photos).toHaveLength(1)
    expect(product.photos[0]!.objectKey).toContain("priced-1.jpg")
    expect(product.photos[0]!.matchedVia).toBe("sku")
    expect(product.publication).toBeNull()

    const lowDetail = await client.product.detail({ id: low })
    expect(lowDetail.product.enrichment!.claims).toEqual([
      { text: "diameter 20 cm", sourceRowIndex: 3 },
    ])
    // Every claim pointer resolves to a loaded source row.
    const claimRows = lowDetail.product.enrichment!.claims.map(
      (claim) => claim.sourceRowIndex
    )
    for (const index of claimRows) {
      expect(
        lowDetail.product.sourceRows.some((row) => row.rowIndex === index)
      ).toBe(true)
    }
  })

  it("throws PRODUCT_NOT_FOUND for unknown and malformed ids", async () => {
    await seedCatalog()
    const [missingError] = await safe(
      client.product.detail({ id: crypto.randomUUID() })
    )
    expect(isDefinedError(missingError)).toBe(true)
    if (isDefinedError(missingError)) {
      expect(missingError.code).toBe("PRODUCT_NOT_FOUND")
    }
    const [malformedError] = await safe(
      client.product.detail({ id: "not-a-uuid" })
    )
    expect(isDefinedError(malformedError)).toBe(false)
  })
})

describe("product.edit (merchant Origin)", () => {
  it("persists edits, marks them manual with confidence 100, and answers their review reasons", async () => {
    const { low } = await seedCatalog()
    const result = await client.product.edit({
      id: low,
      fields: {
        title: "Blumentopf von Hand",
        description: "Terrakotta, 20 cm, handgefertigt.",
      },
    })
    const enrichment = result.product.enrichment!
    expect(enrichment.title).toBe("Blumentopf von Hand")
    expect(enrichment.description).toBe("Terrakotta, 20 cm, handgefertigt.")
    expect(enrichment.fieldOrigins).toMatchObject({
      title: "manual",
      description: "manual",
    })
    expect(enrichment.confidence).toMatchObject({
      title: 100,
      description: 100,
    })
    // The description reason is answered; the category reason stands.
    expect(enrichment.reviewReasons).toHaveLength(1)
    expect(enrichment.reviewReasons[0]).toContain("category:")
    expect(enrichment.status).toBe("needs_review")

    const list = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "all",
      confidence: "all",
    })
    const row = list.rows.find((entry) => entry.id === low)!
    expect(row.editedByMerchant).toBe(true)
    expect(row.title).toBe("Blumentopf von Hand")

    // Fixing the remaining flagged field flips the enrichment ready.
    const final = await client.product.edit({
      id: low,
      fields: { category: "Garden > Pots" },
    })
    expect(final.product.enrichment!.status).toBe("ready")
    expect(final.product.enrichment!.reviewReasons).toEqual([])
  })

  it("edits structured fields too", async () => {
    const { high } = await seedCatalog()
    const result = await client.product.edit({
      id: high,
      fields: {
        tags: ["garden", "watering", "steel"],
        attributes: { Colour: "green", Volume: "5 l" },
      },
    })
    expect(result.product.enrichment!.tags).toEqual([
      "garden",
      "watering",
      "steel",
    ])
    expect(result.product.enrichment!.attributes).toEqual({
      Colour: "green",
      Volume: "5 l",
    })
    expect(result.product.enrichment!.fieldOrigins).toMatchObject({
      tags: "manual",
      attributes: "manual",
    })
  })

  it("rejects unknown products, un-enriched products and empty edits", async () => {
    const { pending } = await seedCatalog()
    const [unknownError] = await safe(
      client.product.edit({
        id: crypto.randomUUID(),
        fields: { title: "Nope" },
      })
    )
    expect(isDefinedError(unknownError)).toBe(true)
    if (isDefinedError(unknownError)) {
      expect(unknownError.code).toBe("PRODUCT_NOT_FOUND")
    }

    const [unenrichedError] = await safe(
      client.product.edit({ id: pending, fields: { title: "Nope" } })
    )
    expect(isDefinedError(unenrichedError)).toBe(true)
    if (isDefinedError(unenrichedError)) {
      expect(unenrichedError.code).toBe("NO_ENRICHMENT")
      expect(unenrichedError.status).toBe(422)
    }

    const [emptyError] = await safe(
      client.product.edit({ id: pending, fields: {} })
    )
    expect(isDefinedError(emptyError)).toBe(false)
  })
})

describe("product.approve (Publications, ADR-0005)", () => {
  it("writes one render-ready row per locale with variants, photos and from-price", async () => {
    const { priced } = await seedCatalog()
    const result = await client.product.approve({ id: priced })
    expect(result.productId).toBe(priced)
    expect(result.publishedLocales).toEqual(["en", "de", "fr"])

    const rows = (await db.db.execute(sql`
      SELECT locale, handle, title, description, price_cents, price_currency,
             variants, photos
      FROM publications WHERE product_id = ${priced}
      ORDER BY locale
    `)) as unknown as Array<{
      locale: string
      handle: string
      title: string
      description: string
      price_cents: number | null
      price_currency: string | null
      variants: Array<Record<string, unknown>>
      photos: Array<Record<string, unknown>>
    }>
    expect(rows).toHaveLength(3)
    const en = rows.find((row) => row.locale === "en")!
    const de = rows.find((row) => row.locale === "de")!
    const fr = rows.find((row) => row.locale === "fr")!
    // The English row carries the enrichment; target locales mirror the
    // translations over the same base (handle stays locale-neutral).
    expect(en.title).toBe("Gießkanne priced")
    expect(de.title).toBe("Brunner Gießkanne 5 Liter")
    expect(de.description).toBe("Robuste Gießkanne.")
    expect(fr.title).toBe("Arrosoir Brunner 5 L")
    expect(new Set([en.handle, de.handle, fr.handle]).size).toBe(1)
    // From-price = cheapest priced Variant (integer cents, EC-021).
    expect(en.price_cents).toBe(990)
    expect(en.price_currency).toBe("EUR")
    // The full purchasable list mirrors into every locale row.
    expect(en.variants).toHaveLength(2)
    expect(fr.variants).toHaveLength(2)
    expect(en.photos).toEqual([
      { objectKey: "imports/default/x/priced-1.jpg", filename: "priced-1.jpg" },
    ])

    // Re-approval refreshes in place — never a duplicate row.
    await client.product.approve({ id: priced })
    const again = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM publications WHERE product_id = ${priced}
    `)) as unknown as Array<{ count: number }>
    expect(again[0]!.count).toBe(3)
  })

  it("rejects un-enriched and unknown products", async () => {
    const { pending } = await seedCatalog()
    const [unenrichedError] = await safe(
      client.product.approve({ id: pending })
    )
    expect(isDefinedError(unenrichedError)).toBe(true)
    if (isDefinedError(unenrichedError)) {
      expect(unenrichedError.code).toBe("NO_ENRICHMENT")
      expect(unenrichedError.status).toBe(422)
    }
    const [unknownError] = await safe(
      client.product.approve({ id: crypto.randomUUID() })
    )
    expect(isDefinedError(unknownError)).toBe(true)
    if (isDefinedError(unknownError)) {
      expect(unknownError.code).toBe("PRODUCT_NOT_FOUND")
    }
  })
})

describe("product.bulkApprove", () => {
  it("approves many in one call, skipping un-enriched products", async () => {
    const { high, medium, pending } = await seedCatalog()
    const result = await client.product.bulkApprove({
      ids: [high, medium, pending],
    })
    expect(result.approved).toBe(2)
    expect(result.productIds.sort()).toEqual([high, medium].sort())
    expect(result.skipped).toEqual([
      { id: pending, reason: "not enriched yet" },
    ])
    const counts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM publications
    `)) as unknown as Array<{ count: number }>
    expect(counts[0]!.count).toBe(6) // 2 products × 3 locales
  })

  it("rejects selections containing unknown products", async () => {
    const { high } = await seedCatalog()
    const [error] = await safe(
      client.product.bulkApprove({
        ids: [high, crypto.randomUUID()],
      })
    )
    expect(isDefinedError(error)).toBe(true)
    if (isDefinedError(error)) {
      expect(error.code).toBe("UNKNOWN_PRODUCTS")
      expect(error.status).toBe(422)
    }
  })
})

describe("product.sendBack (Re-run FACT + retraction)", () => {
  it("retracts Publications, writes the rerun fact and flags the product", async () => {
    const { priced } = await seedCatalog()
    await client.product.approve({ id: priced })
    const result = await client.product.sendBack({ id: priced })
    expect(result).toEqual({
      productId: priced,
      requested: 1,
      stage: "enrich",
    })

    const pubs = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM publications WHERE product_id = ${priced}
    `)) as unknown as Array<{ count: number }>
    expect(pubs[0]!.count).toBe(0) // invisible by construction (ADR-0005)

    const reruns = (await db.db.execute(sql`
      SELECT stage, product_ids FROM reruns WHERE import_id = (
        SELECT import_id FROM products WHERE id = ${priced}
      )
    `)) as unknown as Array<{ stage: string; product_ids: string[] }>
    expect(reruns).toHaveLength(1)
    expect(reruns[0]!.stage).toBe("enrich")
    expect(reruns[0]!.product_ids).toEqual([priced])

    const flagged = (await db.db.execute(sql`
      SELECT needs_review, review_reason FROM products WHERE id = ${priced}
    `)) as unknown as Array<{
      needs_review: boolean
      review_reason: string | null
    }>
    expect(flagged[0]!.needs_review).toBe(true)
    expect(flagged[0]!.review_reason).toContain("Sent back")

    const list = await client.product.list({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      dir: "desc",
      status: "needs_review",
      confidence: "all",
    })
    expect(list.rows.some((row) => row.id === priced)).toBe(true)
  })

  it("throws PRODUCT_NOT_FOUND for an unknown product", async () => {
    await seedCatalog()
    const [error] = await safe(
      client.product.sendBack({ id: crypto.randomUUID() })
    )
    expect(isDefinedError(error)).toBe(true)
    if (isDefinedError(error)) {
      expect(error.code).toBe("PRODUCT_NOT_FOUND")
    }
  })
})
