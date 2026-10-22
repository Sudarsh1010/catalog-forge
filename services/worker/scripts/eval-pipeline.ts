/**
 * Shared Eval Set machinery (Tickets #13/#20): seed the Import exactly as the
 * upload route would, run the full pipeline to completion against a
 * configurable provider registry (Demo Mode stub by default, the real OpenAI
 * provider for Layer 2), and collect the pipeline output for scoring.
 */
import path from "node:path"
import { readdirSync, readFileSync } from "node:fs"

import Yazl from "yazl"
import { parse } from "csv-parse"
import { sql } from "drizzle-orm"

import {
  createWorker,
  createProviderRegistry,
  createStubProvider,
  defineHandlers,
  type ProviderEntry,
} from "../src/index.js"
import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import { createEnrichHandler } from "../src/enrich/handler.js"
import { createTranslateHandler } from "../src/translate/handler.js"
import { createFinaliseHandler } from "../src/finalise/handler.js"
import { planCleanStage } from "../src/clean/plan.js"
import { planGroupStage } from "../src/group/plan.js"
import { planMatchMediaStage } from "../src/media/plan.js"
import { planFinaliseStage } from "../src/finalise/plan.js"
import { identityKey } from "../src/group/keys.js"
import {
  connectEvalDb,
  createEvalDatabase,
  dropEvalDatabase,
  evalCache,
  evalStorage,
  putEvalObject,
  seedEvalImport,
  seedEvalImportFile,
} from "../test/eval-db.js"

export const EVAL_DIR = path.resolve(import.meta.dirname, "../../../eval")
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"

export interface GoldVariant {
  row: number
  sku: string | null
  priceCents: number | null
  currency: string | null
  attributes?: Record<string, string>
}

export interface GoldProduct {
  id: string
  title: string
  sourceRows: number[]
  variants: GoldVariant[]
  photos: string[]
  needsReview?: boolean
  claims?: string[]
}

export interface GoldQuantity {
  row: number
  column: string
  value: number
  unit: "mm" | "g" | "ml"
}

export interface GoldLabels {
  sheet: string
  products: GoldProduct[]
  quantities: GoldQuantity[]
  parkedPhotos: string[]
}

/** Run one raw read-only query against the eval database. */
export async function query<T>(
  database: {
    db: { execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown> }
  },
  text: string
): Promise<T[]> {
  return (await database.db.execute(sql.raw(text))) as T[]
}

/** Wait for a DB condition or fail with a useful message. */
async function waitFor(
  message: string,
  check: () => Promise<boolean>,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`eval timed out: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Zip the committed photo folder the way a merchant upload arrives. */
async function buildPhotoZip(): Promise<Buffer> {
  const zipfile = new Yazl.ZipFile()
  for (const name of readdirSync(path.join(EVAL_DIR, "photos")).sort()) {
    zipfile.addFile(path.join(EVAL_DIR, "photos", name), name)
  }
  const chunks: Buffer[] = []
  const { promise: done, resolve } = Promise.withResolvers<void>()
  zipfile.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
  zipfile.outputStream.on("end", resolve)
  zipfile.end()
  await done
  return Buffer.concat(chunks)
}

export interface ProductRow {
  id: string
  natural_key: string
  needs_review: boolean
}

export interface VariantRow {
  product_id: string
  sku: string | null
  price_cents: number | null
  price_currency: string | null
  attributes: Record<string, string>
}

export interface EnrichmentRow {
  product_id: string
  source_row_indexes: number[]
  title: string
  category: string
  tags: string[]
  claims: Array<{ text: string; sourceRowIndex: number; sourceColumn?: string }>
}

export interface PhotoRow {
  filename: string
  product_id: string
}

export interface ParkedRow {
  filename: string
}

export interface CleanedRow {
  row_index: number
  values: Array<
    | { kind: "quantity"; value: number; unit: string }
    | { kind: "text"; value: string; key: string }
    | { kind: "price"; cents: number; currency: string }
    | { kind: "unparseable"; value: string }
    | { kind: string; value?: string }
    | null
  >
}

export interface EvalRun {
  gold: GoldLabels
  /** The sheet's parsed header row. */
  header: string[]
  products: ProductRow[]
  variants: VariantRow[]
  enrichments: EnrichmentRow[]
  matched: PhotoRow[]
  parked: ParkedRow[]
  cleaned: CleanedRow[]
}

/**
 * Seed the Eval Set and run the pipeline to completion. `providerEntries`
 * defaults to Demo Mode (stub, both tiers) — Layer 2 passes the real OpenAI
 * entries instead.
 */
export async function runEvalPipeline(options?: {
  providerEntries?: ProviderEntry[]
}): Promise<EvalRun> {
  const gold = JSON.parse(
    readFileSync(path.join(EVAL_DIR, "gold-labels.json"), "utf8")
  ) as GoldLabels
  const sheet = readFileSync(path.join(EVAL_DIR, gold.sheet))

  // Parse the header the way intake would (quoted `;`-delimited fields).
  const headerText = sheet.toString("utf8").split(/\r?\n/)[0]!
  const header: string[] = await new Promise((resolve, reject) => {
    parse(headerText, { delimiter: ";" }, (err, rows) => {
      if (err !== undefined && err !== null) reject(err)
      else resolve(rows[0] as string[])
    })
  })

  await createEvalDatabase(DATABASE_URL)
  const db = connectEvalDb(DATABASE_URL)
  const cache = evalCache()
  const storage = evalStorage()

  try {
    // ---- Seed the Import exactly as the upload route would. ----
    const imp = await seedEvalImport(db, { sheetHeader: header })
    await putEvalObject(storage, imp.sheetObjectKey, sheet, "text/csv")
    const zip = await buildPhotoZip()
    await putEvalObject(
      storage,
      `eval-tests/${imp.id}/photos.zip`,
      zip,
      "application/zip"
    )
    await seedEvalImportFile(db, {
      importId: imp.id,
      storeId: imp.storeId,
      kind: "photo_zip",
      objectKey: `eval-tests/${imp.id}/photos.zip`,
      filename: "photos.zip",
      contentType: "application/zip",
      sizeBytes: zip.length,
    })

    // ---- Run the full pipeline to completion. ----
    const registry = () =>
      createProviderRegistry(
        options?.providerEntries ?? [
          {
            provider: createStubProvider(),
            concurrency: 4,
            tiers: ["fast", "strong"],
          },
        ]
      )
    const worker = createWorker({
      db,
      handlers: defineHandlers({
        intake: createIntakeHandler({ storage, cache }),
        clean: createCleanHandler(),
        group: createGroupHandler(),
        "match-media": createMatchMediaHandler(),
        enrich: createEnrichHandler({ registry: registry() }),
        translate: createTranslateHandler({ registry: registry() }),
        finalise: createFinaliseHandler({ cache }),
      }),
      cache,
      config: {
        workerId: "w-eval",
        claimIntervalMs: 10,
        sweepIntervalMs: 25,
        batchSize: 25,
      },
      planners: {
        clean: planCleanStage,
        group: planGroupStage,
        "match-media": planMatchMediaStage,
        finalise: planFinaliseStage,
      },
    })
    worker.start()
    try {
      await waitFor("import completed", async () => {
        const rows = await query<{ status: string }>(
          db,
          `SELECT status::text AS status FROM imports WHERE id = '${imp.id}'`
        )
        return rows[0]?.status === "completed"
      })
    } finally {
      await worker.stop()
    }

    // ---- Collect pipeline output. ----
    const products = await query<ProductRow>(
      db,
      `SELECT id::text AS id, natural_key, needs_review FROM products WHERE import_id = '${imp.id}'`
    )
    const variants = await query<VariantRow>(
      db,
      `SELECT product_id::text AS product_id, sku, price_cents, price_currency, attributes
       FROM variants WHERE import_id = '${imp.id}'`
    )
    const enrichments = await query<EnrichmentRow>(
      db,
      `SELECT product_id::text AS product_id, source_row_indexes, title, category, tags, claims
       FROM product_enrichments WHERE import_id = '${imp.id}'`
    )
    const matched = await query<PhotoRow>(
      db,
      `SELECT f.filename, pp.product_id::text AS product_id
       FROM product_photos pp JOIN import_files f ON f.id = pp.import_file_id
       WHERE pp.import_id = '${imp.id}'`
    )
    const parked = await query<ParkedRow>(
      db,
      `SELECT f.filename FROM parked_photos p
       JOIN import_files f ON f.id = p.import_file_id
       WHERE p.import_id = '${imp.id}'`
    )
    const cleaned = await query<CleanedRow>(
      db,
      `SELECT row_index, values FROM cleaned_rows WHERE import_id = '${imp.id}'`
    )

    return {
      gold,
      header,
      products,
      variants,
      enrichments,
      matched,
      parked,
      cleaned,
    }
  } finally {
    await cache.close()
    await db.close()
    if (process.env.EVAL_KEEP_DB === undefined) {
      await dropEvalDatabase(DATABASE_URL)
    } else {
      console.log("eval database kept for inspection: catalog_forge_eval")
    }
  }
}

// --------------------------------------------------------- Layer 1 scoring --

export function variantLabel(gv: GoldVariant): string {
  return gv.sku ?? `attrs:${JSON.stringify(gv.attributes ?? {})}`
}

/** Layer 1 outcome: exact-match hit/total per field plus miss detail. */
export interface Layer1Result {
  scores: Record<string, [number, number]>
  /** Rows grouped into Products no gold Product claims. */
  extraProducts: number
  /** Parked photos no gold entry accounts for. */
  extraParked: number
  /** Matched photos no gold entry accounts for. */
  extraMatched: number
  /** Per-field miss descriptions. */
  misses: Record<string, string[]>
}

/**
 * Deterministic Demo-Mode Layer 1 scoring (Ticket #13): exact-match
 * hit/total per structured field over the whole Eval Set.
 */
export function scoreLayer1(run: EvalRun): Layer1Result {
  const {
    gold,
    header,
    products,
    variants,
    enrichments,
    matched,
    parked,
    cleaned,
  } = run

  const productById = new Map(products.map((p) => [p.id, p]))
  const variantsByProduct = new Map<string, VariantRow[]>()
  for (const variant of variants) {
    const list = variantsByProduct.get(variant.product_id) ?? []
    list.push(variant)
    variantsByProduct.set(variant.product_id, list)
  }
  const rowsByProduct = new Map<string, Set<number>>(
    enrichments.map((enrichment) => [
      enrichment.product_id,
      new Set(enrichment.source_row_indexes),
    ])
  )

  // ---- Score: grouping. ----
  const groupedRows = new Map<number, string>() // row → predicted product id
  for (const [productId, rows] of rowsByProduct) {
    for (const rowIndex of rows) groupedRows.set(rowIndex, productId)
  }
  let groupingHit = 0
  const groupingMisses: string[] = []
  for (const gp of gold.products) {
    const predictedRows = gp.sourceRows.map((r) => groupedRows.get(r) ?? null)
    const productId = predictedRows[0]
    const same =
      productId !== null &&
      productId !== undefined &&
      predictedRows.every((p) => p === productId) &&
      new Set(rowsByProduct.get(productId) ?? []).size ===
        gp.sourceRows.length &&
      gp.sourceRows.every((r) =>
        (rowsByProduct.get(productId) ?? new Set()).has(r)
      )
    if (same) groupingHit += 1
    else groupingMisses.push(gp.id)
  }
  const extraProducts = products.length - groupingHit

  // ---- Score: dedupe (Variant count per matched Product). ----
  let dedupeHit = 0
  const dedupeMisses: string[] = []
  for (const gp of gold.products) {
    const productId = groupedRows.get(gp.sourceRows[0]!)
    if (productId === undefined) continue
    const predicted = variantsByProduct.get(productId) ?? []
    if (predicted.length === gp.variants.length) dedupeHit += 1
    else
      dedupeMisses.push(`${gp.id} (${predicted.length}≠${gp.variants.length})`)
  }

  // ---- Score: price cents + currency per gold Variant. ----
  let priceTotal = 0
  let priceHit = 0
  const priceMisses: string[] = []
  for (const gp of gold.products) {
    const productId = groupedRows.get(gp.sourceRows[0]!)
    if (productId === undefined) {
      priceTotal += gp.variants.length
      priceMisses.push(`${gp.id}: product missing`)
      continue
    }
    const predicted = variantsByProduct.get(productId) ?? []
    for (const gv of gp.variants) {
      priceTotal += 1
      const candidate = predicted.find((pv) => {
        if (gv.sku !== null) {
          return pv.sku !== null && identityKey(pv.sku) === identityKey(gv.sku)
        }
        const colour = gv.attributes?.["Farbe"]
        return (
          colour !== undefined &&
          identityKey(pv.attributes["Farbe"] ?? "") === identityKey(colour)
        )
      })
      if (candidate === undefined) {
        priceMisses.push(`${gp.id}/${variantLabel(gv)}: variant missing`)
        continue
      }
      if (
        candidate.price_cents === gv.priceCents &&
        candidate.price_currency === gv.currency
      ) {
        priceHit += 1
      } else {
        priceMisses.push(
          `${gp.id}/${variantLabel(gv)}: got ${candidate.price_cents ?? "null"} ${candidate.price_currency ?? ""}, want ${gv.priceCents ?? "null"} ${gv.currency ?? ""}`
        )
      }
    }
  }

  // ---- Score: canonical units per cleaned quantity cell. ----
  const columnIndex = new Map(header.map((name, index) => [name, index]))
  let unitTotal = gold.quantities.length
  let unitHit = 0
  const unitMisses: string[] = []
  const cleanedByRow = new Map(cleaned.map((row) => [row.row_index, row]))
  for (const gq of gold.quantities) {
    const row = cleanedByRow.get(gq.row)
    const index = columnIndex.get(gq.column)
    const cell =
      row !== undefined && index !== undefined ? row.values[index] : undefined
    if (
      cell !== undefined &&
      cell !== null &&
      cell.kind === "quantity" &&
      "unit" in cell &&
      cell.value === gq.value &&
      cell.unit === gq.unit
    ) {
      unitHit += 1
    } else {
      const got =
        cell === undefined || cell === null
          ? "absent"
          : cell.kind === "quantity" && "unit" in cell
            ? `${cell.value} ${cell.unit}`
            : cell.kind
      unitMisses.push(
        `row ${gq.row} ${gq.column}: got ${got}, want ${gq.value} ${gq.unit}`
      )
    }
  }

  // ---- Score: photo matching. ----
  const photoProduct = new Map(matched.map((m) => [m.filename, m.product_id]))
  const photoGold = new Map<string, string | null>()
  for (const gp of gold.products) {
    for (const filename of gp.photos) photoGold.set(filename, gp.id)
  }
  for (const filename of gold.parkedPhotos) photoGold.set(filename, null)
  let photoTotal = photoGold.size
  let photoHit = 0
  const photoMisses: string[] = []
  const goldProductId = new Map(gold.products.map((gp) => [gp.id, gp]))
  for (const [filename, goldId] of photoGold) {
    const predictedProductId = photoProduct.get(filename)
    const isParked =
      predictedProductId === undefined &&
      parked.some((p) => p.filename === filename)
    if (goldId === null) {
      if (isParked) photoHit += 1
      else photoMisses.push(`${filename}: got matched, want parked`)
    } else if (predictedProductId !== undefined) {
      const gp = goldProductId.get(goldId)
      const predictedRows2 =
        rowsByProduct.get(predictedProductId) ?? new Set<number>()
      if (gp !== undefined && gp.sourceRows.every((r) => predictedRows2.has(r)))
        photoHit += 1
      else photoMisses.push(`${filename}: matched wrong product`)
    } else if (isParked) {
      photoMisses.push(`${filename}: parked, want ${goldId}`)
    } else {
      photoMisses.push(`${filename}: no row at all`)
    }
  }
  const extraParked = parked.filter((p) => !photoGold.has(p.filename)).length
  const extraMatched = matched.filter((m) => !photoGold.has(m.filename)).length

  // ---- Score: review status per matched Product. ----
  let reviewTotal = 0
  let reviewHit = 0
  const reviewMisses: string[] = []
  for (const gp of gold.products) {
    const productId = groupedRows.get(gp.sourceRows[0]!)
    if (productId === undefined) continue
    reviewTotal += 1
    const predicted = productById.get(productId)
    if ((predicted?.needs_review ?? false) === (gp.needsReview ?? false))
      reviewHit += 1
    else
      reviewMisses.push(
        `${gp.id}: got ${predicted?.needs_review}, want ${gp.needsReview ?? false}`
      )
  }

  return {
    scores: {
      grouping: [groupingHit, gold.products.length],
      dedupe: [dedupeHit, gold.products.length],
      price: [priceHit, priceTotal],
      units: [unitHit, unitTotal],
      photos: [photoHit, photoTotal],
      review: [reviewHit, reviewTotal],
    },
    extraProducts,
    extraParked,
    extraMatched,
    misses: {
      grouping: groupingMisses,
      dedupe: dedupeMisses,
      price: priceMisses,
      units: unitMisses,
      photos: photoMisses,
      review: reviewMisses,
    },
  }
}
