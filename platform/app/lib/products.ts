/**
 * Products read models for the review tab (spec user stories 20–24) — the
 * oRPC `product` namespace's hydration, alongside `lib/imports.ts`. Reads
 * span every Import of the Store: the tab is the catalog, not one Import.
 *
 * Approval state is derived, never stored on the Product: a Publication's
 * existence IS approval (ADR-0005), so `status` folds three truths —
 * Publications (approved), the Needs Review flags (product + enrichment),
 * and enrichment presence (pending). The derived literal lives in SQL so
 * filters and sorts run on the same expression the row displays.
 */
import type { Database } from "@workspace/db"
import { sql, type SQL } from "drizzle-orm"

import {
  CONFIDENCE_HIGH_FROM,
  CONFIDENCE_LOW_BELOW,
  type ProductDetailDto,
  type ProductEditFields,
  type ProductListResult,
  type ProductListRow,
  type ProductStatus,
} from "@workspace/contracts"

/** Merchant-fixable identifier guard for URL-provided Product ids. */
import { UUID_RE } from "./imports"

function rowsOf<T>(result: unknown): T[] {
  return result as T[]
}

/** Anything that can run SQL: the pooled Database or a transaction. */
export type SqlExecutor = Pick<Database, "execute">

/**
 * Raw-SQL timestamps surface as `Date` or driver string depending on the
 * runtime's module identity — coerce at the DTO boundary, never trust one.
 */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString()
}

/**
 * The derived review status of one Product, expressed once and reused by
 * list and detail: Publications win (approved), then any Needs Review
 * flag, then enrichment presence separates ready from pending. Repeats the
 * Publications probe because Postgres select-list items cannot reference
 * sibling aliases.
 */
const STATUS_SQL = sql`
  CASE WHEN EXISTS (SELECT 1 FROM publications pub
                    WHERE pub.product_id = p.id) THEN 'approved'
       WHEN p.needs_review OR e.status = 'needs_review' THEN 'needs_review'
       WHEN e.status IS NULL THEN 'pending'
       ELSE 'ready' END`

export interface ProductListQuery {
  page: number
  pageSize: number
  sort: "title" | "status" | "confidence" | "messiness" | "updatedAt"
  dir: "asc" | "desc"
  search?: string | undefined
  status: "all" | ProductStatus
  confidence: "all" | "low" | "medium" | "high"
  importId?: string | undefined
}

/**
 * The catalog table query: one statement computes every row's derived
 * status, weakest-field confidence and counts, then filters, sorts and
 * paginates server-side; the total rides on a window function so paging
 * never needs a second count scan.
 */
export async function loadProductList(
  db: SqlExecutor,
  query: ProductListQuery
): Promise<ProductListResult> {
  const offset = (query.page - 1) * query.pageSize

  const conditions = [sql`TRUE`]
  if (query.search !== undefined && query.search.trim().length > 0) {
    const like = `%${query.search.trim().replace(/[\\%_]/g, "\\$&")}%`
    conditions.push(sql`(
      e.title ILIKE ${like} OR p.title ILIKE ${like}
      OR e.handle ILIKE ${like} OR p.natural_key ILIKE ${like}
      OR p.brand ILIKE ${like}
    )`)
  }
  if (query.importId !== undefined) {
    conditions.push(sql`p.import_id = ${query.importId}`)
  }
  const where = sql.join(conditions, sql` AND `)

  // Status and confidence filter on derived columns, so they apply in a
  // second layer — Postgres WHERE cannot see select-list aliases.
  const derived = [sql`TRUE`]
  if (query.status === "approved") derived.push(sql`publication_count > 0`)
  if (query.status === "needs_review")
    derived.push(
      sql`publication_count = 0 AND (needs_review OR enrichment_status = 'needs_review')`
    )
  if (query.status === "ready")
    derived.push(
      sql`publication_count = 0 AND enrichment_status = 'ready' AND NOT needs_review`
    )
  if (query.status === "pending")
    derived.push(sql`publication_count = 0 AND enrichment_status IS NULL`)
  if (query.confidence !== "all") {
    if (query.confidence === "low")
      derived.push(
        sql`min_confidence IS NOT NULL AND min_confidence < ${CONFIDENCE_LOW_BELOW}`
      )
    if (query.confidence === "medium")
      derived.push(
        sql`min_confidence >= ${CONFIDENCE_LOW_BELOW} AND min_confidence < ${CONFIDENCE_HIGH_FROM}`
      )
    if (query.confidence === "high")
      derived.push(sql`min_confidence >= ${CONFIDENCE_HIGH_FROM}`)
  }
  const having = sql.join(derived, sql` AND `)

  const dir = query.dir === "asc" ? sql`ASC` : sql`DESC`
  const sortKeys: Record<ProductListQuery["sort"], SQL> = {
    title: sql`title ${dir}`,
    status: sql`status ${dir}`,
    confidence: sql`min_confidence ${dir} NULLS LAST`,
    messiness: sql`messiness ${dir} NULLS LAST`,
    updatedAt: sql`updated_at ${dir}`,
  }

  const rows = rowsOf<{
    id: string
    import_id: string
    import_filename: string
    natural_key: string
    source_title: string
    enriched_title: string | null
    handle: string | null
    status: string
    reason_list: string[]
    confidence: Record<string, number> | null
    min_confidence: number | null
    messiness: number | null
    row_indexes: number[]
    photo_count: number
    edited_by_merchant: boolean
    published_locales: string[] | null
    total: number
    updated_at: Date | string
  }>(
    await db.execute(sql`
      WITH base AS (
        SELECT p.id, p.import_id, p.needs_review,
               p.updated_at, p.title AS source_title,
               i.original_filename AS import_filename, p.natural_key,
               e.title AS enriched_title, e.handle, e.status AS enrichment_status,
               e.confidence, e.review_reasons, e.field_origins, e.messiness,
               e.source_row_indexes,
               (SELECT count(*)::int FROM publications pub
                WHERE pub.product_id = p.id) AS publication_count,
               (SELECT jsonb_agg(DISTINCT pub.locale) FROM publications pub
                WHERE pub.product_id = p.id) AS published_locales,
               (SELECT count(*)::int FROM product_photos pp
                WHERE pp.product_id = p.id) AS photo_count,
               (SELECT min((f.value #>> '{}')::double precision)
                FROM jsonb_each(e.confidence) AS f(key, value)) AS min_confidence,
               EXISTS (SELECT 1 FROM jsonb_each(e.field_origins)
                       WHERE value #>> '{}' = 'manual') AS edited_by_merchant,
               ${STATUS_SQL} AS status
        FROM products p
        JOIN imports i ON i.id = p.import_id
        LEFT JOIN product_enrichments e ON e.product_id = p.id
        WHERE ${where}
      ),
      filtered AS (
        SELECT * FROM base WHERE ${having}
      )
      SELECT *,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(review_reasons) = 'array'
               THEN review_reasons ELSE '[]'::jsonb END)), '{}') AS reason_list,
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(source_row_indexes) = 'array'
               THEN source_row_indexes ELSE '[]'::jsonb END)), '{}') AS row_indexes,
        (count(*) OVER ())::int AS total
      FROM filtered
      ORDER BY ${sortKeys[query.sort]}, id
      LIMIT ${query.pageSize} OFFSET ${offset}
    `)
  )

  const listRows: ProductListRow[] = rows.map((row) => ({
    id: row.id,
    importId: row.import_id,
    importFilename: row.import_filename,
    naturalKey: row.natural_key,
    title: row.enriched_title ?? row.source_title,
    handle: row.handle,
    status: row.status as ProductStatus,
    reviewReasons: row.reason_list ?? [],
    confidence: row.confidence ?? {},
    minConfidence: row.min_confidence,
    messiness: row.messiness,
    sourceRowCount: row.row_indexes.length,
    photoCount: row.photo_count,
    editedByMerchant: row.edited_by_merchant,
    publishedLocales: row.published_locales ?? [],
    updatedAt: toIso(row.updated_at)!,
  }))
  return {
    rows: listRows,
    total: rows[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  }
}

/**
 * The side-by-side hydration: the AI result (enrichment with per-field
 * Confidence, Origin and Claims), the source truth (Sheet Rows the Product
 * was grouped from — including every Claim's pointer — plus Variants and
 * matched photos), the translations with their Origin and staleness, and
 * the Publication state. Returns `null` for unknown or malformed ids.
 */
export async function loadProductDetail(
  db: SqlExecutor,
  id: string
): Promise<ProductDetailDto | null> {
  if (!UUID_RE.test(id)) return null

  const rows = rowsOf<{
    id: string
    import_id: string
    import_filename: string
    natural_key: string
    identity_kind: string
    brand: string | null
    gtin: string | null
    needs_review: boolean
    created_at: Date | string
    sheet_header: string[] | null
    status: string
    /** `to_jsonb(e)` minus ids/timestamps — snake_case enrichment keys. */
    enrichment: Record<string, unknown> | null
    published_locales: string[] | null
    published_at: Date | string | null
  }>(
    await db.execute(sql`
      SELECT p.id, p.import_id, p.needs_review, p.natural_key,
             p.identity_kind::text AS identity_kind,
             p.brand, p.gtin, p.created_at,
             i.original_filename AS import_filename, i.sheet_header,
             ${STATUS_SQL} AS status,
             to_jsonb(e) - 'id' - 'store_id' - 'import_id' - 'product_id'
               - 'created_at' AS enrichment,
             (SELECT jsonb_agg(DISTINCT pub.locale) FROM publications pub
              WHERE pub.product_id = p.id) AS published_locales,
             (SELECT max(pub.published_at) FROM publications pub
              WHERE pub.product_id = p.id) AS published_at
      FROM products p
      JOIN imports i ON i.id = p.import_id
      LEFT JOIN product_enrichments e ON e.product_id = p.id
      WHERE p.id = ${id}
    `)
  )
  const row = rows[0]
  if (!row) return null

  const raw = row.enrichment
  const enrichment = raw
    ? {
        title: raw.title as string,
        handle: raw.handle as string,
        description: (raw.description as string | null) ?? "",
        category: (raw.category as string | null) ?? "",
        tags: (raw.tags as string[] | null) ?? [],
        attributes: (raw.attributes as Record<string, string> | null) ?? {},
        confidence: (raw.confidence as Record<string, number> | null) ?? {},
        fieldOrigins:
          (raw.field_origins as Record<string, "ai" | "manual"> | null) ?? {},
        status: raw.status as "ready" | "needs_review",
        reviewReasons: (raw.review_reasons as string[] | null) ?? [],
        claims: (raw.claims as ClaimRows | null) ?? [],
        sourceRowIndexes: (raw.source_row_indexes as number[] | null) ?? [],
        messiness: Number(raw.messiness ?? 0),
        updatedAt: toIso(raw.updated_at as Date | string)!,
      }
    : null

  // Variants in the deterministic variant_key order the handlers use.
  const variantRows = rowsOf<{
    id: string
    sku: string | null
    gtin: string | null
    price_cents: number | null
    price_currency: string | null
    attributes: Record<string, string> | null
    image_ref: string | null
    source_row_index: number
    needs_review: boolean
    review_reason: string | null
  }>(
    await db.execute(sql`
      SELECT id, sku, gtin, price_cents, price_currency, attributes,
             image_ref, source_row_index, needs_review, review_reason
      FROM variants WHERE product_id = ${id}
      ORDER BY variant_key
    `)
  )

  // Every source pointer the panel can cite: the grouped rows, each
  // Claim's pointer, and each Variant's origin row.
  const rowIndexes = new Set<number>(enrichment?.sourceRowIndexes ?? [])
  for (const claim of enrichment?.claims ?? []) {
    rowIndexes.add(claim.sourceRowIndex)
  }
  for (const variant of variantRows) rowIndexes.add(variant.source_row_index)
  const sourceRows =
    rowIndexes.size > 0
      ? rowsOf<{ row_index: number; raw: SourceCells }>(
          await db.execute(sql`
            SELECT row_index, raw FROM sheet_rows
            WHERE import_id = ${row.import_id}
              AND row_index IN (${sql.join(
                [...rowIndexes].map((index) => sql`${index}`),
                sql`, `
              )})
            ORDER BY row_index
          `)
        ).map((entry) => ({
          rowIndex: entry.row_index,
          cells: entry.raw.map((cell) =>
            cell === null ||
            typeof cell === "string" ||
            typeof cell === "number" ||
            typeof cell === "boolean"
              ? cell
              : String(cell)
          ),
        }))
      : []

  const photoRows = rowsOf<{
    file_id: string
    filename: string
    object_key: string
    matched_via: string
    matched_token: string
  }>(
    await db.execute(sql`
      SELECT f.id AS file_id, f.filename, f.object_key,
             pp.matched_via::text AS matched_via, pp.matched_token
      FROM product_photos pp
      JOIN import_files f ON f.id = pp.import_file_id
      WHERE pp.product_id = ${id}
      ORDER BY f.filename
    `)
  )

  const translationRows = rowsOf<{
    locale: string
    field: string
    text: string
    origin: string
    out_of_date: boolean
  }>(
    await db.execute(sql`
      SELECT locale, field, text, origin::text AS origin, out_of_date
      FROM product_translations WHERE product_id = ${id}
      ORDER BY locale, field
    `)
  )

  const publishedLocales = row.published_locales ?? []
  return {
    id: row.id,
    importId: row.import_id,
    importFilename: row.import_filename,
    naturalKey: row.natural_key,
    identityKind: row.identity_kind as "code" | "title",
    brand: row.brand,
    gtin: row.gtin,
    createdAt: toIso(row.created_at)!,
    status: row.status as ProductStatus,
    enrichment,
    sheetHeader: row.sheet_header ?? [],
    sourceRows,
    variants: variantRows.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      gtin: variant.gtin,
      priceCents: variant.price_cents,
      priceCurrency: variant.price_currency,
      attributes: variant.attributes ?? {},
      imageRef: variant.image_ref,
      sourceRowIndex: variant.source_row_index,
      needsReview: variant.needs_review,
      reviewReason: variant.review_reason,
    })),
    photos: photoRows.map((photo) => ({
      fileId: photo.file_id,
      filename: photo.filename,
      objectKey: photo.object_key,
      matchedVia: photo.matched_via,
      matchedToken: photo.matched_token,
    })),
    translations: translationRows.map((translation) => ({
      locale: translation.locale,
      field: translation.field,
      text: translation.text,
      origin: translation.origin as "ai" | "manual",
      outOfDate: translation.out_of_date,
    })),
    publication:
      publishedLocales.length > 0 && row.published_at !== null
        ? {
            locales: publishedLocales,
            publishedAt: toIso(row.published_at)!,
          }
        : null,
  }
}

type SourceCells = Array<string | number | boolean | null>

type ClaimRows = Array<{ text: string; sourceRowIndex: number }>

/**
 * Persist merchant edits on the enriched fields (GLOSSARY: Origin) and
 * recompute the flag state: edited fields turn `manual` with confidence
 * 100, review reasons about them drop, and the enrichment status follows
 * the kept reasons. The Product-level Needs Review flag is NOT touched —
 * clearing it is the approve decision, not an edit.
 */
export type EditProductResult =
  | { ok: true; product: ProductDetailDto }
  | { ok: false; reason: "not_found" | "no_enrichment" }

export async function editProduct(
  db: SqlExecutor,
  id: string,
  fields: ProductEditFields
): Promise<EditProductResult> {
  const edited = Object.entries(fields).filter(
    ([, value]) => value !== undefined
  )
  if (edited.length === 0) return { ok: false, reason: "no_enrichment" }

  const existing = rowsOf<{ status: string | null }>(
    await db.execute(sql`
      SELECT e.status FROM products p
      LEFT JOIN product_enrichments e ON e.product_id = p.id
      WHERE p.id = ${id}
    `)
  )[0]
  if (existing === undefined) return { ok: false, reason: "not_found" }
  if (existing.status === null) return { ok: false, reason: "no_enrichment" }

  const sets: SQL[] = []
  for (const [field, value] of edited) {
    if (field === "attributes") {
      sets.push(sql`attributes = ${JSON.stringify(value)}::jsonb`)
    } else if (field === "tags") {
      sets.push(sql`tags = ${JSON.stringify(value)}::jsonb`)
    } else {
      sets.push(sql`${sql.identifier(field)} = ${value}`)
    }
    sets.push(
      sql`field_origins = field_origins || ${JSON.stringify({ [field]: "manual" })}::jsonb`,
      sql`confidence = confidence || ${JSON.stringify({ [field]: 100 })}::jsonb`
    )
  }
  // Reasons the merchant answered with an edit stop flagging the Product;
  // the status follows the kept reasons.
  const editedKeys = edited.map(([field]) => field)
  sets.push(
    sql`review_reasons = COALESCE((
      SELECT jsonb_agg(r ORDER BY ord)
      FROM jsonb_array_elements(review_reasons) WITH ORDINALITY AS t(r, ord)
      WHERE split_part(r #>> '{}', ':', 1) <> ALL(${editedKeys}::text[])
    ), '[]'::jsonb)`
  )
  sets.push(
    sql`status = CASE WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(review_reasons) AS r
      WHERE split_part(r #>> '{}', ':', 1) <> ALL(${editedKeys}::text[])
    ) THEN 'needs_review'::enrichment_status ELSE 'ready'::enrichment_status END`
  )

  await db.execute(sql`
    UPDATE product_enrichments SET ${sql.join(sets, sql`, `)},
      updated_at = now()
    WHERE product_id = ${id}
  `)
  const product = await loadProductDetail(db, id)
  return product !== null
    ? { ok: true, product }
    : { ok: false, reason: "not_found" }
}

/**
 * Write the Publications for approved Products (ADR-0005): one render-ready
 * row per (Product × locale) — the English snapshot from the enrichment,
 * every target locale mirroring it with the Product's translations where
 * present — plus the full Variant list, the matched photos and the cheapest
 * Variant's from-price in each row. Re-approval overwrites in place
 * (idempotent snapshot refresh); a Product under review gets no rows at
 * all, so storefront invisibility holds by construction.
 *
 * One set-based statement so bulk approval costs the same as single;
 * returns the Product ids that got Publications (those with an enrichment).
 * Callers run it inside their transaction.
 */
export async function writePublications(
  db: SqlExecutor,
  productIds: string[]
): Promise<string[]> {
  if (productIds.length === 0) return []
  const written = rowsOf<{ product_id: string }>(
    await db.execute(sql`
      INSERT INTO publications (
        store_id, product_id, locale, handle, title, description, category,
        tags, attributes, price_cents, price_currency, variants, photos
      )
      SELECT e.store_id, e.product_id, loc.locale, e.handle,
             COALESCE(t.title, e.title),
             COALESCE(t.description, e.description),
             COALESCE(t.category, e.category),
             e.tags, e.attributes,
             fp.price_cents, fp.price_currency,
             vagg.variants, ph.photos
      FROM product_enrichments e
      CROSS JOIN (VALUES ('en'), ('de'), ('fr')) AS loc(locale)
      LEFT JOIN LATERAL (
        SELECT
          (SELECT pt.text FROM product_translations pt
           WHERE pt.product_id = e.product_id AND pt.locale = loc.locale
             AND pt.field = 'title') AS title,
          (SELECT pt.text FROM product_translations pt
           WHERE pt.product_id = e.product_id AND pt.locale = loc.locale
             AND pt.field = 'description') AS description,
          (SELECT pt.text FROM product_translations pt
           WHERE pt.product_id = e.product_id AND pt.locale = loc.locale
             AND pt.field = 'category') AS category
      ) t ON TRUE
      LEFT JOIN LATERAL (
        SELECT v.price_cents, v.price_currency FROM variants v
        WHERE v.product_id = e.product_id AND v.price_cents IS NOT NULL
        ORDER BY v.price_cents, v.variant_key
        LIMIT 1
      ) fp ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'sku', v.sku, 'gtin', v.gtin,
                 'priceCents', v.price_cents,
                 'priceCurrency', v.price_currency,
                 'attributes', COALESCE(v.attributes, '{}'::jsonb),
                 'imageRef', v.image_ref) ORDER BY v.variant_key),
               '[]'::jsonb) AS variants
        FROM variants v WHERE v.product_id = e.product_id
      ) vagg ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'objectKey', f.object_key, 'filename', f.filename)
                 ORDER BY f.filename), '[]'::jsonb) AS photos
        FROM product_photos pp
        JOIN import_files f ON f.id = pp.import_file_id
        WHERE pp.product_id = e.product_id
      ) ph ON TRUE
      WHERE e.product_id IN (${sql.join(
        productIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
      ON CONFLICT (product_id, locale) DO UPDATE SET
        handle = EXCLUDED.handle,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        tags = EXCLUDED.tags,
        attributes = EXCLUDED.attributes,
        price_cents = EXCLUDED.price_cents,
        price_currency = EXCLUDED.price_currency,
        variants = EXCLUDED.variants,
        photos = EXCLUDED.photos,
        published_at = now()
      RETURNING product_id
    `)
  )
  return [...new Set(written.map((row) => row.product_id))]
}
