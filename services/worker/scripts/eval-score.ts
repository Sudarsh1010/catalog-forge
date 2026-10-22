/**
 * Eval Set Layer 1 scoring (Ticket 13 / spec #11 user story 30–31).
 *
 * Runs the FULL pipeline in Demo Mode (stub provider — no API key, no AI
 * calls) over the committed messy supplier sheet (`eval/supplier-sheet.csv`
 * + `eval/photos/*.png` shipped as one ZIP), then diffs the pipeline output
 * against the hand-verified Gold Labels (`eval/gold-labels.json`).
 *
 * Reports per-field EXACT-match accuracy for the deterministic layer:
 *   grouping (Sheet Rows → Products), dedupe (Variant count per Product),
 *   price cents + currency per Variant, canonical units per cleaned cell,
 *   photo matching (matched product / Parked Photo), review status.
 *
 * Prerequisites: dev services up (`pnpm services:up`). The script creates a
 * throwaway `catalog_forge_eval` database and cleans up after itself.
 *
 * Run: pnpm --filter @workspace/worker eval:l1
 */
import { pathToFileURL } from "node:url"
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

const EVAL_DIR = path.resolve(import.meta.dirname, "../../../eval")
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"

interface GoldVariant {
  row: number
  sku: string | null
  priceCents: number | null
  currency: string | null
  attributes?: Record<string, string>
}

interface GoldProduct {
  id: string
  title: string
  sourceRows: number[]
  variants: GoldVariant[]
  photos: string[]
  needsReview?: boolean
  claims?: string[]
}

interface GoldQuantity {
  row: number
  column: string
  value: number
  unit: "mm" | "g" | "ml"
}

interface GoldLabels {
  sheet: string
  products: GoldProduct[]
  quantities: GoldQuantity[]
  parkedPhotos: string[]
}

/** Run one raw read-only query against the eval database. */
async function query<T>(
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

interface ProductRow {
  id: string
  natural_key: string
  needs_review: boolean
}

interface VariantRow {
  product_id: string
  sku: string | null
  price_cents: number | null
  price_currency: string | null
  attributes: Record<string, string>
}

interface EnrichmentRow {
  product_id: string
  source_row_indexes: number[]
}

interface PhotoRow {
  filename: string
  product_id: string
}

interface ParkedRow {
  filename: string
}

interface CleanedRow {
  row_index: number
  values: Array<
    { kind: "quantity"; value: number; unit: string } | { kind: string } | null
  >
}

async function main(): Promise<void> {
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

    // ---- Run the full pipeline to completion in Demo Mode. ----
    const demoRegistry = () =>
      createProviderRegistry([
        {
          provider: createStubProvider(),
          concurrency: 4,
          tiers: ["fast", "strong"],
        },
      ])
    const worker = createWorker({
      db,
      handlers: defineHandlers({
        intake: createIntakeHandler({ storage, cache }),
        clean: createCleanHandler(),
        group: createGroupHandler(),
        "match-media": createMatchMediaHandler(),
        enrich: createEnrichHandler({ registry: demoRegistry() }),
        translate: createTranslateHandler({ registry: demoRegistry() }),
        finalise: createFinaliseHandler({ cache }),
      }),
      cache,
      config: {
        workerId: "w-eval-l1",
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
      `SELECT product_id::text AS product_id, source_row_indexes
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
        dedupeMisses.push(
          `${gp.id} (${predicted.length}≠${gp.variants.length})`
        )
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
            return (
              pv.sku !== null && identityKey(pv.sku) === identityKey(gv.sku)
            )
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
        cell.value === gq.value &&
        cell.unit === gq.unit
      ) {
        unitHit += 1
      } else {
        const got =
          cell === undefined || cell === null
            ? "absent"
            : cell.kind === "quantity"
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
        if (
          gp !== undefined &&
          gp.sourceRows.every((r) => predictedRows2.has(r))
        )
          photoHit += 1
        else photoMisses.push(`${filename}: matched wrong product`)
      } else if (isParked) {
        photoMisses.push(`${filename}: parked, want ${goldId}`)
      } else {
        photoMisses.push(`${filename}: no row at all`)
      }
    }
    const extraParked = parked.filter((p) => !photoGold.has(p.filename)).length
    const extraMatched = matched.filter(
      (m) => !photoGold.has(m.filename)
    ).length

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

    const pct = (hit: number, total: number): string =>
      total === 0
        ? "n/a"
        : `${((100 * hit) / total).toFixed(1)}% (${hit}/${total})`

    const scores: Record<string, [number, number]> = {
      grouping: [groupingHit, gold.products.length],
      dedupe: [dedupeHit, gold.products.length],
      price: [priceHit, priceTotal],
      units: [unitHit, unitTotal],
      photos: [photoHit, photoTotal],
      review: [reviewHit, reviewTotal],
    }

    // CI gate: the recorded baseline (eval/thresholds.json) is the floor.
    // A regression on any Layer 1 field fails the run.
    const thresholds = JSON.parse(
      readFileSync(path.join(EVAL_DIR, "thresholds.json"), "utf8")
    ) as Record<string, { hit: number; total: number }>
    let regressed = false
    for (const [field, [hit, total]] of Object.entries(scores)) {
      const floor = thresholds[field]
      if (floor !== undefined && hit < floor.hit) {
        console.error(
          `REGRESSION ${field}: ${hit}/${total} below baseline floor ${floor.hit}/${floor.total}`
        )
        regressed = true
      }
    }
    if (regressed) process.exitCode = 1

    console.log("=== Eval Set — Layer 1 (Demo Mode, keyless) ===")
    console.log(
      `sheet rows: ${cleaned.length}, gold products: ${gold.products.length}, gold variants: ${gold.products.reduce((sum, gp) => sum + gp.variants.length, 0)}`
    )
    console.log(
      `grouping      : ${pct(groupingHit, gold.products.length)} (extra products: ${extraProducts})`
    )
    console.log(`dedupe        : ${pct(dedupeHit, gold.products.length)}`)
    console.log(`price cents   : ${pct(priceHit, priceTotal)}`)
    console.log(`units         : ${pct(unitHit, unitTotal)}`)
    console.log(
      `photo matching: ${pct(photoHit, photoTotal)} (extra parked: ${extraParked}, extra matched: ${extraMatched})`
    )
    console.log(`review status : ${pct(reviewHit, reviewTotal)}`)
    const misses: Array<[string, string[]]> = [
      ["grouping", groupingMisses],
      ["dedupe", dedupeMisses],
      ["price", priceMisses],
      ["units", unitMisses],
      ["photos", photoMisses],
      ["review", reviewMisses],
    ]
    for (const [field, list] of misses) {
      if (list.length > 0)
        console.log(
          `\n-- ${field} misses:\n  ${list.slice(0, 40).join("\n  ")}`
        )
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

function variantLabel(gv: GoldVariant): string {
  return gv.sku ?? `attrs:${JSON.stringify(gv.attributes ?? {})}`
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
