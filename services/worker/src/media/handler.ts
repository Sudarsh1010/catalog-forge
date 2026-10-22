/**
 * The `match-media` Stage handler: attaches the Import's uploaded photos to
 * Products by ranked strategies (EC-072) and parks everything unmatched —
 * nothing silently dropped (GLOSSARY: Parked Photo).
 *
 * Idempotent (ADR-0003): the assignment is recomputed deterministically from
 * the Import's photos and Products and reconciled in one transaction —
 * upsert-shaped replace of this Import's match rows — so a redelivered Job
 * converges on the identical state.
 */
import { and, asc, eq, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import {
  importFiles,
  imports,
  parkedPhotos,
  productPhotos,
  products,
  variants,
} from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import type { JobContext, JobHandler } from "../handlers"
import { identityKey } from "../group/keys"
import { matchPhoto, type MatchableProduct, type PhotoMatch } from "./match"

const log = createLogger({ service: "worker:match-media" })

const INSERT_BATCH = 500

const PARKED_DEFAULT_REASON =
  "No SKU/GTIN token in the filename, no title match and no subfolder hint matched any Product (EC-072)."
const NO_PRODUCTS_REASON =
  "No Products were grouped from this sheet, so this photo had nothing to match against (EC-072)."

interface ImportRecord {
  id: string
  storeId: string
  status: string
}

interface PhotoRecord {
  id: string
  filename: string
}

export function createMatchMediaHandler(): JobHandler {
  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx
    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `match-media: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op

    const [photos, matchables] = await Promise.all([
      loadPhotos(db, job.importId),
      loadMatchables(db, job.importId),
    ])

    const matches: Array<PhotoRecord & { match: PhotoMatch }> = []
    const parked: Array<PhotoRecord & { reason: string }> = []
    for (const photo of photos) {
      const match =
        matchables.length > 0 ? matchPhoto(photo.filename, matchables) : null
      if (match) matches.push({ ...photo, match })
      else
        parked.push({
          ...photo,
          reason:
            matchables.length > 0 ? PARKED_DEFAULT_REASON : NO_PRODUCTS_REASON,
        })
    }

    await reconcile(db, imp.storeId, job.importId, matches, parked)

    log.info(`match-media completed`, {
      importId: job.importId,
      jobId: job.id,
      photos: photos.length,
      matched: matches.length,
      parked: parked.length,
    })
  }
}

async function loadImport(
  db: Database,
  importId: string
): Promise<ImportRecord | null> {
  const rows = await db
    .select({
      id: imports.id,
      storeId: imports.storeId,
      status: imports.status,
    })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)
  return rows[0] ?? null
}

async function loadPhotos(
  db: Database,
  importId: string
): Promise<PhotoRecord[]> {
  return db
    .select({ id: importFiles.id, filename: importFiles.filename })
    .from(importFiles)
    .where(
      and(eq(importFiles.importId, importId), eq(importFiles.kind, "photo"))
    )
    .orderBy(asc(importFiles.createdAt), asc(importFiles.id))
}

async function loadMatchables(
  db: Database,
  importId: string
): Promise<MatchableProduct[]> {
  const rows = await db
    .select({
      productId: products.id,
      naturalKey: products.naturalKey,
      title: products.title,
      productGtin: products.gtin,
      variantId: variants.id,
      variantKey: variants.variantKey,
      sku: variants.sku,
      variantGtin: variants.gtin,
      attributes: variants.attributes,
    })
    .from(products)
    .leftJoin(variants, eq(variants.productId, products.id))
    .where(eq(products.importId, importId))
    .orderBy(asc(products.naturalKey), asc(variants.variantKey))

  const byProduct = new Map<string, MatchableProduct>()
  for (const row of rows) {
    let product = byProduct.get(row.productId)
    if (!product) {
      product = {
        productId: row.productId,
        naturalKey: row.naturalKey,
        titleKey: identityKey(row.title),
        gtin: row.productGtin,
        variants: [],
      }
      byProduct.set(row.productId, product)
    }
    if (row.variantId !== null) {
      product.variants.push({
        variantId: row.variantId,
        variantKey: row.variantKey ?? "",
        sku: row.sku,
        gtin: row.variantGtin,
        attributes: row.attributes ?? {},
      })
    }
  }
  return [...byProduct.values()]
}

/** Replace this Import's match rows with the freshly computed assignment. */
async function reconcile(
  db: Database,
  storeId: string,
  importId: string,
  matches: Array<PhotoRecord & { match: PhotoMatch }>,
  parked: Array<PhotoRecord & { reason: string }>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(productPhotos).where(eq(productPhotos.importId, importId))
    await tx.delete(parkedPhotos).where(eq(parkedPhotos.importId, importId))

    for (let index = 0; index < matches.length; index += INSERT_BATCH) {
      const batch = matches.slice(index, index + INSERT_BATCH)
      await tx.insert(productPhotos).values(
        batch.map(({ id, match }) => ({
          storeId,
          importId,
          importFileId: id,
          productId: match.productId,
          variantId: match.variantId,
          matchedVia: match.via,
          matchedToken: match.token,
        }))
      )
    }
    for (let index = 0; index < parked.length; index += INSERT_BATCH) {
      const batch = parked.slice(index, index + INSERT_BATCH)
      await tx.insert(parkedPhotos).values(
        batch.map(({ id, reason }) => ({
          storeId,
          importId,
          importFileId: id,
          reason,
          ec: "EC-072",
        }))
      )
    }
  })
}
