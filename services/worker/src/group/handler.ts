/**
 * The `group` Barrier Stage handler: ONE Job observes ALL cleaned rows of
 * the Import and collapses them into Products and Variants on scoped
 * Natural Keys — duplicated, split and out-of-order rows converge (EC-033,
 * EC-060, EC-061), identity is folded through NFC/invisible/case keys
 * (EC-034, EC-035), and the Natural Key is scoped to the sheet family so
 * the same supplier code from two sources stays two Products (EC-032).
 *
 * Re-import key-diff (ticket #14): a changed re-upload of a sheet family
 * adopts its predecessor's catalog — unchanged rows are no-ops,
 * price/weight-like changes patch the Variant via the Fast Path (no
 * enrichment re-run), other changes update the Product, new rows append,
 * and Variants absent from the new sheet become Missing-from-Source for
 * the merchant to decide (never deleted).
 *
 * The Row Ledger links every Sheet Row to its Product or its failure reason
 * — the only source of "the counts add up" (GLOSSARY: Row Ledger).
 *
 * Idempotent by construction (ADR-0003): Products upsert on
 * (store, family, natural-key hash) — EC-068's database guarantee, racing
 * workers included — Variants on (product, variant-key hash), and ledger
 * rows on (import, row_index); a re-delivered barrier converges with zero
 * duplicates. Stage advancement and the enrich/translate fan-out happen in
 * the Job machinery's completion transaction, not here.
 */
import { and, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { CleanColumnPlan, CleanedCell } from "@workspace/db/schema"
import {
  cleanPlans,
  imports,
  productEnrichments,
  products,
  rowLedger,
  variants,
} from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

import type { JobContext, JobHandler } from "../handlers"
import { UnionFind, codeFamilyRelation, familyBase } from "./cluster"
import { mapColumns, type ColumnRoles } from "./columns"
import { identityKey, keyHash, normalizeGtin } from "./keys"

const log = createLogger({ service: "worker:group" })

/** Rows scanned / rows upserted per statement — bounded, like clean. */
const SCAN_PAGE_SIZE = 5_000
const UPSERT_BATCH = 200

const NO_IDENTITY_REASON =
  "No usable identity: the row has neither a supplier code nor a title to group by (EC-031)."
const NEVER_CLEANED_REASON =
  "Row never cleaned — its clean Job exhausted its attempts. Retry the import from the dashboard."
const TITLE_IDENTITY_REASON =
  "No supplier code — grouped by normalized title, which is lower confidence. Verify this Product (EC-031)."

interface SourceRow {
  rowIndex: number
  /** Normalized supplier code (identityKey of SKU or padded GTIN). */
  code: string | null
  codeKind: "sku" | "gtin"
  skuDisplay: string | null
  /** Normalized GTIN (EC-036). */
  gtin: string | null
  titleKey: string | null
  title: string | null
  brand: string | null
  category: string | null
  description: string | null
  price: { cents: number; currency: string } | null
  imageRef: string | null
  /** Variant-axis values by header, display form (EC-063). */
  attributes: Record<string, string>
  /** Canonical attribute identity for sku-less variants (EC-064). */
  attributeKey: string
}

interface VariantDraft {
  variantKey: string
  sku: string | null
  gtin: string | null
  priceCents: number | null
  priceCurrency: string | null
  attributes: Record<string, string>
  imageRef: string | null
  sourceRowIndex: number
  needsReview: boolean
  reviewReason: string | null
}

interface ProductDraft {
  naturalKey: string
  naturalKeyHash: string
  identityKind: "code" | "title"
  title: string
  brand: string | null
  category: string | null
  description: string | null
  gtin: string | null
  needsReview: boolean
  reviewReason: string | null
  variants: VariantDraft[]
  /** The rows merged into this Product, with the Variant each landed in. */
  memberRows: Array<{ rowIndex: number; variantKey: string }>
}

interface ImportRecord {
  id: string
  storeId: string
  familyKey: string
  status: string
}

export function createGroupHandler(): JobHandler {
  return async (ctx: JobContext): Promise<void> => {
    const { job, db } = ctx
    const imp = await loadImport(db, job.importId)
    if (!imp) {
      throw new Error(
        `group: import ${job.importId} not found for job ${job.id}`
      )
    }
    if (imp.status === "failed") return // terminal; idempotent no-op

    const [header, columns] = await loadSheetShape(db, job.importId)
    const roles = mapColumns(header, columns)

    // The barrier observes ALL rows: cleaned ones become SourceRows; rows
    // whose clean Batch died land in the ledger as Failed (accounting).
    const rows: SourceRow[] = []
    const neverCleaned: number[] = []
    await scanRows(db, job.importId, (rowIndex, cleaned) => {
      if (!cleaned) {
        neverCleaned.push(rowIndex)
        return
      }
      rows.push(extractRow(rowIndex, cleaned, header, roles))
    })

    const drafts = buildProductDrafts(rows)
    const { ledgerProductId, ledgerVariantId, reviewByRowIndex } =
      await writeCatalog(db, imp.storeId, imp.familyKey, job.importId, drafts)

    await writeLedger(
      db,
      imp.storeId,
      job.importId,
      rows,
      neverCleaned,
      ledgerProductId,
      ledgerVariantId,
      reviewByRowIndex
    )

    log.info(`group barrier completed`, {
      importId: job.importId,
      jobId: job.id,
      rows: rows.length + neverCleaned.length,
      products: drafts.length,
      failedRows: neverCleaned.length,
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
      familyKey: imports.familyKey,
      status: imports.status,
    })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)
  return rows[0] ?? null
}

/** Header + clean plan: both landed by earlier stages in their own transactions. */
async function loadSheetShape(
  db: Database,
  importId: string
): Promise<[string[], CleanColumnPlan[]]> {
  const importRows = await db
    .select({ sheetHeader: imports.sheetHeader })
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1)
  const header = importRows[0]?.sheetHeader
  if (!header) {
    throw new Error(`group: import ${importId} has no sheet header`)
  }
  const planRows = await db
    .select({ columns: cleanPlans.columns })
    .from(cleanPlans)
    .where(eq(cleanPlans.importId, importId))
    .limit(1)
  const columns = planRows[0]?.columns
  if (!columns) {
    throw new Error(`group: no clean plan for import ${importId}`)
  }
  return [header, columns]
}

/** Page through all rows (cleaned projection left-joined), in row order. */
async function scanRows(
  db: Database,
  importId: string,
  visit: (rowIndex: number, cleaned: Array<CleanedCell | null> | null) => void
): Promise<void> {
  let last = 0
  for (;;) {
    const page = (await db.execute(sql`
      SELECT sr.row_index, cr.values AS cleaned
      FROM sheet_rows sr
      LEFT JOIN cleaned_rows cr
        ON cr.import_id = sr.import_id AND cr.row_index = sr.row_index
      WHERE sr.import_id = ${importId} AND sr.row_index > ${last}
      ORDER BY sr.row_index
      LIMIT ${SCAN_PAGE_SIZE}
    `)) as unknown as Array<{
      row_index: number
      cleaned: Array<CleanedCell | null> | null
    }>
    for (const row of page) visit(row.row_index, row.cleaned)
    if (page.length < SCAN_PAGE_SIZE) return
    last = page[page.length - 1]!.row_index
  }
}

/**
 * The text substrate identity works on. Columns the clean Stage could not
 * type (`unparseable`) or read as quantities still preserve the original
 * string — grouping uses the supplier's text, not a guess (e.g. a title
 * column classified as quantities because titles carry "5L").
 */
function textAt(
  cells: Array<CleanedCell | null>,
  index: number | null
): string | null {
  if (index === null) return null
  const cell = cells[index]
  if (!cell) return null
  if (cell.kind === "text" && cell.value.length > 0) return cell.value
  if (cell.kind === "unparseable" && cell.value.trim().length > 0)
    return cell.value
  if (cell.kind === "quantity") return cell.original
  return null
}

function priceAt(
  cells: Array<CleanedCell | null>,
  index: number | null
): { cents: number; currency: string } | null {
  if (index === null) return null
  const cell = cells[index]
  return cell?.kind === "price"
    ? { cents: cell.cents, currency: cell.currency }
    : null
}

/** Project one cleaned row onto the identity fields grouping works with. */
function extractRow(
  rowIndex: number,
  cells: Array<CleanedCell | null>,
  header: string[],
  roles: ColumnRoles
): SourceRow {
  const skuDisplay = textAt(cells, roles.skuIndex)
  const gtinDisplay = textAt(cells, roles.gtinIndex)
  const gtin = gtinDisplay ? normalizeGtin(gtinDisplay) : null
  const title = textAt(cells, roles.titleIndex)
  const titleKey = title ? identityKey(title) : null

  const attributes: Record<string, string> = {}
  const attributeKeyParts: string[] = []
  for (const index of roles.attributeIndexes) {
    const value = textAt(cells, index)
    if (value === null) continue
    const name = header[index] ?? `col${index}`
    attributes[name] = value
    attributeKeyParts.push(`${identityKey(name)}=${identityKey(value)}`)
  }
  attributeKeyParts.sort()

  let code: string | null = null
  let codeKind: "sku" | "gtin" = "sku"
  if (skuDisplay) {
    const key = identityKey(skuDisplay)
    if (key.length > 0) code = key
  }
  if (code === null && gtin !== null) {
    code = gtin
    codeKind = "gtin"
  }

  return {
    rowIndex,
    code,
    codeKind,
    skuDisplay,
    gtin,
    titleKey,
    title,
    brand: textAt(cells, roles.brandIndex),
    category: textAt(cells, roles.categoryIndex),
    description: textAt(cells, roles.descriptionIndex),
    price: priceAt(cells, roles.priceIndex),
    imageRef: textAt(cells, roles.imageRefIndex),
    attributes,
    attributeKey: attributeKeyParts.join("|"),
  }
}

/**
 * Cluster rows into Products and merge each cluster's rows into Variants.
 * Deterministic in the row set: identical inputs derive identical keys and
 * merges, so re-delivered barriers converge (ADR-0003).
 */
export function buildProductDrafts(rows: SourceRow[]): ProductDraft[] {
  const groupable = rows.filter(
    (row) => row.code !== null || row.titleKey !== null
  )

  // Union-find over the groupable rows.
  const uf = new UnionFind(groupable.length)

  // 1. Exact normalized code: duplicated rows collapse (EC-034/EC-061).
  const byCode = new Map<string, number[]>()
  groupable.forEach((row, index) => {
    if (row.code === null) return
    const list = byCode.get(row.code)
    if (list) {
      uf.union(list[0]!, index)
      list.push(index)
    } else {
      byCode.set(row.code, [index])
    }
  })

  // 2. Code families, corroborated inside normalized-title buckets
  //    (EC-033): parent links merge on the prefix evidence alone; sibling
  //    links need the equal-title corroboration the bucket provides
  //    (EC-060's "multiple weak keys must agree").
  const byTitle = new Map<string, number[]>()
  groupable.forEach((row, index) => {
    if (row.titleKey === null) return
    const list = byTitle.get(row.titleKey)
    if (list) list.push(index)
    else byTitle.set(row.titleKey, [index])
  })
  for (const bucket of byTitle.values()) {
    const coded = bucket.filter((index) => groupable[index]!.code !== null)
    for (let a = 0; a < coded.length; a++) {
      for (let b = a + 1; b < coded.length; b++) {
        const rowA = groupable[coded[a]!]!
        const rowB = groupable[coded[b]!]!
        const relation = codeFamilyRelation(rowA.code!, rowB.code!)
        if (relation !== null) uf.union(coded[a]!, coded[b]!)
      }
    }
    // 3. Split rows without a code join the bucket's single code family
    //    (EC-060); with two or more families the evidence disagrees —
    //    conservative split instead of a guess (EC-062).
    const families = new Set(coded.map((index) => uf.find(index)))
    if (coded.length > 0 && families.size === 1) {
      for (const index of bucket) {
        if (groupable[index]!.code === null) uf.union(coded[0]!, index)
      }
    }
  }

  // 4. Code-less rows with no family to join group by title+brand (EC-031
  //    fallback — the Product is flagged Needs Review at draft time).
  const byTitleBrand = new Map<string, number>()
  groupable.forEach((row, index) => {
    if (row.code !== null || row.titleKey === null) return
    const key = `${row.titleKey}|${row.brand ? identityKey(row.brand) : ""}`
    const anchor = byTitleBrand.get(key)
    if (anchor === undefined) byTitleBrand.set(key, index)
    else uf.union(anchor, index)
  })

  const clusters = new Map<number, SourceRow[]>()
  groupable.forEach((row, index) => {
    const root = uf.find(index)
    const list = clusters.get(root)
    if (list) list.push(row)
    else clusters.set(root, [row])
  })

  return [...clusters.values()]
    .map((cluster) => buildDraft(cluster))
    .sort((a, b) => (a.naturalKey < b.naturalKey ? -1 : 1))
}

/** Merge one cluster's rows into a Product draft (richer copy wins, EC-061). */
function buildDraft(cluster: SourceRow[]): ProductDraft {
  const ordered = [...cluster].sort((a, b) => a.rowIndex - b.rowIndex)
  const coded = ordered.filter((row) => row.code !== null)
  const identityKind: "code" | "title" = coded.length > 0 ? "code" : "title"

  let naturalKey: string
  if (identityKind === "code") {
    const base = familyBase(coded.map((row) => row.code!))
    // Codes in one family share their kind in practice; the smallest code's
    // kind decides the prefix deterministically for the degenerate mix.
    const anchorKind = [...coded].sort((a, b) =>
      a.code! < b.code! ? -1 : 1
    )[0]!.codeKind
    naturalKey = `${anchorKind}:${base}`
  } else {
    const first = ordered[0]!
    const brandKey = first.brand ? identityKey(first.brand) : ""
    naturalKey = `title:${first.titleKey}${brandKey ? `|brand:${brandKey}` : ""}`
  }

  const variantsByKeY = new Map<string, VariantDraft>()
  const variantKeyByRow = new Map<number, string>()
  for (const row of ordered) {
    const variantKey =
      row.code !== null
        ? `${row.codeKind}:${row.code}`
        : row.attributeKey.length > 0
          ? `attrs:${row.attributeKey}`
          : `title:${row.titleKey ?? ""}`
    variantKeyByRow.set(row.rowIndex, variantKey)
    const existing = variantsByKeY.get(variantKey)
    if (!existing) {
      variantsByKeY.set(variantKey, {
        variantKey,
        sku: row.skuDisplay,
        gtin: row.gtin,
        priceCents: row.price?.cents ?? null,
        priceCurrency: row.price?.currency ?? null,
        attributes: { ...row.attributes },
        imageRef: row.imageRef,
        sourceRowIndex: row.rowIndex,
        needsReview: false,
        reviewReason: null,
      })
      continue
    }
    mergeVariant(existing, row)
  }

  const variantList = [...variantsByKeY.values()].sort((a, b) =>
    a.variantKey < b.variantKey ? -1 : 1
  )

  // Product fields: first non-blank in row order wins; description takes the
  // longest non-blank (the richer copy, EC-061).
  let title = ""
  let brand: string | null = null
  let category: string | null = null
  let description: string | null = null
  for (const row of ordered) {
    if (title === "" && row.title !== null) title = row.title
    if (brand === null && row.brand !== null) brand = row.brand
    if (category === null && row.category !== null) category = row.category
    if (
      description === null ||
      description.length === 0 ||
      (row.description !== null && row.description.length > description.length)
    ) {
      if (row.description !== null) description = row.description
    }
  }

  // Product-level GTIN: set only when every variant agrees (EC-033's
  // disagreement → review rule applied to the GTIN family).
  const distinctGtins = new Set(
    ordered
      .map((row) => row.gtin)
      .filter((gtin): gtin is string => gtin !== null)
  )
  let gtin: string | null = null
  let needsReview = false
  let reviewReason: string | null = null
  if (distinctGtins.size === 1) {
    gtin = [...distinctGtins][0]!
  } else if (distinctGtins.size > 1) {
    needsReview = true
    reviewReason = `Multiple GTINs under one Product: ${[...distinctGtins].sort().join(", ")} (EC-033).`
  }
  if (identityKind === "title") {
    needsReview = true
    reviewReason = reviewReason ?? TITLE_IDENTITY_REASON
  }
  const variantConflict = variantList.find((variant) => variant.needsReview)
  if (variantConflict) {
    needsReview = true
    reviewReason = reviewReason ?? variantConflict.reviewReason
  }

  return {
    naturalKey,
    naturalKeyHash: keyHash(naturalKey),
    identityKind,
    title: title.length > 0 ? title : naturalKey,
    brand,
    category,
    description,
    gtin,
    needsReview,
    reviewReason,
    variants: variantList,
    memberRows: ordered.map((row) => ({
      rowIndex: row.rowIndex,
      variantKey: variantKeyByRow.get(row.rowIndex)!,
    })),
  }
}

/** Merge one row into its variant: blanks yield to filled values (EC-061). */
function mergeVariant(existing: VariantDraft, row: SourceRow): void {
  if (existing.sku === null && row.skuDisplay !== null)
    existing.sku = row.skuDisplay
  if (existing.gtin === null && row.gtin !== null) existing.gtin = row.gtin
  if (existing.imageRef === null && row.imageRef !== null)
    existing.imageRef = row.imageRef
  if (row.price !== null) {
    if (existing.priceCents === null) {
      existing.priceCents = row.price.cents
      existing.priceCurrency = row.price.currency
    } else if (
      existing.priceCents !== row.price.cents ||
      existing.priceCurrency !== row.price.currency
    ) {
      // Conflicting duplicates: same variant key, two prices → review with
      // both values shown (EC-061). The first copy in row order keeps the field.
      existing.needsReview = true
      existing.reviewReason =
        `Conflicting prices for this variant: ${existing.priceCents} ` +
        `${existing.priceCurrency ?? ""} vs ${row.price.cents} ` +
        `${row.price.currency} cents (EC-061).`
    }
  }
  for (const [name, value] of Object.entries(row.attributes)) {
    const current = existing.attributes[name]
    if (current === undefined || current === "")
      existing.attributes[name] = value
  }
}

interface CatalogWrites {
  ledgerProductId: Map<number, string>
  ledgerVariantId: Map<number, string>
  /** Whether the row's Product/Variant carries Needs Review. */
  reviewByRowIndex: Map<number, boolean>
}

/** The transaction handle every catalog write statement runs inside. */
type CatalogTx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/** Whether every member of `subset` is also in `superset`. */
function containsAll(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) if (!superset.has(value)) return false
  return true
}

/**
 * The family's living catalog: every Product of the sheet family plus its
 * Variants (GLOSSARY: Fast Path, Missing-from-Source). A re-import adopts
 * these rows instead of appending duplicates — the unique index
 * (store_id, family_key, natural_key_hash) backs the guarantee at the
 * storage layer, so races converge on the same row no matter what.
 */
interface FamilyVariant {
  id: string
  variantKeyHash: string
  sku: string | null
  gtin: string | null
  priceCents: number | null
  priceCurrency: string | null
  attributes: Record<string, string>
  imageRef: string | null
  missingFromSource: boolean
}

interface FamilyProduct {
  id: string
  /** The birth Import — translate re-runs requeue its Jobs (ticket #15). */
  importId: string
  naturalKeyHash: string
  identityKind: "code" | "title"
  naturalKey: string
  title: string
  brand: string | null
  category: string | null
  description: string | null
  gtin: string | null
  needsReview: boolean
  reviewReason: string | null
  variants: Map<string, FamilyVariant>
}

interface FamilyCatalog {
  products: Map<string, FamilyProduct>
}

async function loadFamilyCatalog(
  db: Database,
  storeId: string,
  familyKey: string
): Promise<FamilyCatalog> {
  const productRows = (await db.execute(sql`
    SELECT id, import_id, natural_key_hash, identity_kind, natural_key,
           title, brand, category, description, gtin, needs_review,
           review_reason
    FROM products
    WHERE store_id = ${storeId} AND family_key = ${familyKey}
  `)) as unknown as Array<{
    id: string
    import_id: string
    natural_key_hash: string
    identity_kind: "code" | "title"
    natural_key: string
    title: string
    brand: string | null
    category: string | null
    description: string | null
    gtin: string | null
    needs_review: boolean
    review_reason: string | null
  }>
  const products = new Map<string, FamilyProduct>()
  const productsById = new Map<string, FamilyProduct>()
  for (const row of productRows) {
    const product: FamilyProduct = {
      id: row.id,
      importId: row.import_id,
      naturalKeyHash: row.natural_key_hash,
      identityKind: row.identity_kind,
      naturalKey: row.natural_key,
      title: row.title,
      brand: row.brand,
      category: row.category,
      description: row.description,
      gtin: row.gtin,
      needsReview: row.needs_review,
      reviewReason: row.review_reason,
      variants: new Map(),
    }
    products.set(row.natural_key_hash, product)
    productsById.set(row.id, product)
  }
  if (products.size === 0) return { products }
  const variantRows = (await db.execute(sql`
    SELECT v.id, v.product_id, v.variant_key_hash, v.sku, v.gtin,
           v.price_cents, v.price_currency, v.attributes, v.image_ref,
           v.missing_from_source
    FROM variants v
    WHERE v.store_id = ${storeId}
      AND v.product_id IN (
        SELECT id FROM products
        WHERE store_id = ${storeId} AND family_key = ${familyKey}
      )
  `)) as unknown as Array<{
    id: string
    product_id: string
    variant_key_hash: string
    sku: string | null
    gtin: string | null
    price_cents: number | null
    price_currency: string | null
    attributes: Record<string, string>
    image_ref: string | null
    missing_from_source: boolean
  }>
  for (const row of variantRows) {
    productsById.get(row.product_id)?.variants.set(row.variant_key_hash, {
      id: row.id,
      variantKeyHash: row.variant_key_hash,
      sku: row.sku,
      gtin: row.gtin,
      priceCents: row.price_cents,
      priceCurrency: row.price_currency,
      attributes: row.attributes ?? {},
      imageRef: row.image_ref,
      missingFromSource: row.missing_from_source,
    })
  }
  return { products }
}

/**
 * Upsert the catalog with re-import key-diff (ticket #14). Three shapes:
 *
 * 1. ADOPT — the Natural Key already exists in the family's catalog. The
 *    existing Product/Variant rows are diffed against the new drafts:
 *    unchanged rows are no-ops (no statement, no `updated_at` churn),
 *    price/weight-like changes patch the Variant in place (Fast Path), other
 *    changes update the Product row. Adopted rows KEEP their birth
 *    `import_id`, which is what keeps them out of this Import's enrich and
 *    translate Batches (both plan over `products.import_id = this Import`) —
 *    the Fast Path costs no AI calls by construction. Variants of the family
 *    catalog absent from the new sheet flip to Missing-from-Source and are
 *    never deleted; ones that reappear clear the flag.
 * 2. APPEND — a Natural Key the family never saw inserts a new Product
 *    (birth `import_id` = this Import, so it is enriched and translated).
 * 3. RACE — a concurrent barrier inserted the same key between the catalog
 *    load and the insert; the family-scoped unique index upserts onto the
 *    same row, so duplicates are impossible at the storage layer (EC-068).
 *
 * All in one transaction: a redelivered barrier either lands the whole
 * catalog update or none of it, and re-delivery converges (diffs recompute
 * to the same no-op set — ADR-0003).
 */
async function writeCatalog(
  db: Database,
  storeId: string,
  familyKey: string,
  importId: string,
  drafts: ProductDraft[]
): Promise<CatalogWrites> {
  const ledgerProductId = new Map<number, string>()
  const ledgerVariantId = new Map<number, string>()
  const reviewByRowIndex = new Map<number, boolean>()
  if (drafts.length === 0) {
    return { ledgerProductId, ledgerVariantId, reviewByRowIndex }
  }

  const family = await loadFamilyCatalog(db, storeId, familyKey)

  /**
   * Match drafts to the family catalog. Exact Natural Keys adopt directly.
   * A draft whose key misses can still be the SAME Product with a shifted
   * family base: the Natural Key of a code family is the cluster's common
   * prefix, so dropping the last TP-100-G row renames `sku:tp-100` to
   * `sku:tp-100-r`. Keying re-import on that volatile base would duplicate
   * the Product instead of flagging the dropped Variant Missing-from-Source
   * — so a draft also adopts an unclaimed family Product whose Variant set
   * contains (or is contained in) the draft's, refining the Product's
   * Natural Key to the draft's. Only a UNIQUE candidate adopts: two drafts
   * claiming one Product is evidence of a split (EC-062 conservatism) and
   * appends instead. Deterministic in (drafts, catalog), so a redelivered
   * barrier recomputes the same adoption (ADR-0003).
   */
  const adoption = new Map<ProductDraft, FamilyProduct>()
  const claimedProductIds = new Set<string>()
  const unmatched: ProductDraft[] = []
  for (const draft of drafts) {
    const existing = family.products.get(draft.naturalKeyHash)
    if (existing) {
      adoption.set(draft, existing)
      claimedProductIds.add(existing.id)
    } else {
      unmatched.push(draft)
    }
  }
  unmatched.sort((a, b) => (a.naturalKey < b.naturalKey ? -1 : 1))
  const refined = new Set<ProductDraft>()
  for (const draft of unmatched) {
    const draftVariantHashes = new Set(
      draft.variants.map((variant) => keyHash(variant.variantKey))
    )
    const candidates = [...family.products.values()].filter((product) => {
      if (claimedProductIds.has(product.id) || product.variants.size === 0)
        return false
      const productVariantHashes = new Set(product.variants.keys())
      return (
        containsAll(draftVariantHashes, productVariantHashes) ||
        containsAll(productVariantHashes, draftVariantHashes)
      )
    })
    if (candidates.length !== 1) continue
    adoption.set(draft, candidates[0]!)
    refined.add(draft)
    claimedProductIds.add(candidates[0]!.id)
  }
  const fresh = unmatched.filter((draft) => !refined.has(draft))

  await db.transaction(async (tx) => {
    for (const [draft, existing] of adoption) {
      await adoptProductDraft(tx, storeId, importId, draft, existing, {
        ledgerProductId,
        ledgerVariantId,
        reviewByRowIndex,
      })
    }

    // Products the family never saw: plain insert (append). Upsert on the
    // family-scoped key keeps a racing barrier from duplicating (shape 3).
    const productIdByHash = new Map<string, string>()
    for (let index = 0; index < fresh.length; index += UPSERT_BATCH) {
      const batch = fresh.slice(index, index + UPSERT_BATCH)
      const upserted = await tx
        .insert(products)
        .values(
          batch.map((draft) => ({
            storeId,
            importId,
            familyKey,
            identityKind: draft.identityKind,
            naturalKey: draft.naturalKey,
            naturalKeyHash: draft.naturalKeyHash,
            title: draft.title,
            brand: draft.brand,
            category: draft.category,
            description: draft.description,
            gtin: draft.gtin,
            needsReview: draft.needsReview,
            reviewReason: draft.reviewReason,
          }))
        )
        .onConflictDoUpdate({
          target: [
            products.storeId,
            products.familyKey,
            products.naturalKeyHash,
          ],
          set: {
            identityKind: sql`EXCLUDED.identity_kind`,
            naturalKey: sql`EXCLUDED.natural_key`,
            title: sql`EXCLUDED.title`,
            brand: sql`EXCLUDED.brand`,
            category: sql`EXCLUDED.category`,
            description: sql`EXCLUDED.description`,
            gtin: sql`EXCLUDED.gtin`,
            needsReview: sql`EXCLUDED.needs_review`,
            reviewReason: sql`EXCLUDED.review_reason`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: products.id,
          naturalKeyHash: products.naturalKeyHash,
        })
      for (const row of upserted)
        productIdByHash.set(row.naturalKeyHash, row.id)
    }

    // Ledger ids for the appended Products and their Variants.
    const variantDrafts = fresh.flatMap((draft) =>
      draft.variants.map((variant) => ({
        draft,
        variant,
        productId: productIdByHash.get(draft.naturalKeyHash)!,
      }))
    )
    const variantIdByKey = new Map<string, string>()
    for (let index = 0; index < variantDrafts.length; index += UPSERT_BATCH) {
      const batch = variantDrafts.slice(index, index + UPSERT_BATCH)
      const upserted = await tx
        .insert(variants)
        .values(
          batch.map(({ variant, productId }) => ({
            storeId,
            importId,
            productId,
            variantKey: variant.variantKey,
            variantKeyHash: keyHash(variant.variantKey),
            sku: variant.sku,
            gtin: variant.gtin,
            priceCents: variant.priceCents,
            priceCurrency: variant.priceCurrency,
            attributes: variant.attributes,
            imageRef: variant.imageRef,
            sourceRowIndex: variant.sourceRowIndex,
            needsReview: variant.needsReview,
            reviewReason: variant.reviewReason,
          }))
        )
        .onConflictDoUpdate({
          target: [variants.productId, variants.variantKeyHash],
          set: {
            sku: sql`EXCLUDED.sku`,
            gtin: sql`EXCLUDED.gtin`,
            priceCents: sql`EXCLUDED.price_cents`,
            priceCurrency: sql`EXCLUDED.price_currency`,
            attributes: sql`EXCLUDED.attributes`,
            imageRef: sql`EXCLUDED.image_ref`,
            sourceRowIndex: sql`EXCLUDED.source_row_index`,
            needsReview: sql`EXCLUDED.needs_review`,
            reviewReason: sql`EXCLUDED.review_reason`,
            // Present in this sheet again: not Missing-from-Source.
            missingFromSource: sql`false`,
            missingSince: sql`null`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: variants.id,
          productId: variants.productId,
          variantKeyHash: variants.variantKeyHash,
        })
      for (const row of upserted)
        variantIdByKey.set(`${row.productId}:${row.variantKeyHash}`, row.id)
    }

    for (const draft of fresh) {
      const productId = productIdByHash.get(draft.naturalKeyHash)!
      for (const variant of draft.variants) {
        const id = variantIdByKey.get(
          `${productId}:${keyHash(variant.variantKey)}`
        )
        if (id)
          variantKeyToLedger(draft, variant.variantKey, productId, id, {
            ledgerProductId,
            ledgerVariantId,
            reviewByRowIndex,
          })
      }
    }

    // Variants of family Products this import never mentioned: absent from
    // the latest sheet → Missing-from-Source (GLOSSARY). Never deleted; a
    // later re-import that carries them again clears the flag.
    const unclaimed = [...family.products.values()].filter(
      (product) => !claimedProductIds.has(product.id)
    )
    for (let index = 0; index < unclaimed.length; index += UPSERT_BATCH) {
      const batch = unclaimed.slice(index, index + UPSERT_BATCH)
      await tx
        .update(variants)
        .set({
          missingFromSource: true,
          missingSince: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(
              variants.productId,
              batch.map((product) => product.id)
            ),
            eq(variants.missingFromSource, false)
          )
        )
    }
  })

  return { ledgerProductId, ledgerVariantId, reviewByRowIndex }
}

/** Record one row's Product/Variant resolution for the ledger write. */
function variantKeyToLedger(
  draft: ProductDraft,
  variantKey: string,
  productId: string,
  variantId: string,
  writes: CatalogWrites
): void {
  for (const member of draft.memberRows) {
    if (member.variantKey !== variantKey) continue
    writes.ledgerProductId.set(member.rowIndex, productId)
    writes.ledgerVariantId.set(member.rowIndex, variantId)
    const variant = draft.variants.find(
      (candidate) => candidate.variantKey === variantKey
    )
    writes.reviewByRowIndex.set(
      member.rowIndex,
      draft.needsReview || (variant?.needsReview ?? false)
    )
  }
}

/**
 * Key-diff one draft against its adopted family Product (shape 1): patch
 * what changed, flag what vanished, un-flag what reappeared, leave
 * identical rows completely untouched. Appended Variants insert under the
 * adopted Product.
 */
async function adoptProductDraft(
  tx: CatalogTx,
  storeId: string,
  importId: string,
  draft: ProductDraft,
  existing: FamilyProduct,
  writes: CatalogWrites
): Promise<void> {
  // Product fields: EXCLUDED semantics, but only when something actually
  // changed — an unchanged re-upload issues no statement at all.
  const productPatch: Record<string, unknown> = {}
  if (existing.identityKind !== draft.identityKind)
    productPatch.identityKind = draft.identityKind
  // Differs only on refined adoption (variant set shifted the family base).
  if (existing.naturalKeyHash !== draft.naturalKeyHash)
    productPatch.naturalKeyHash = draft.naturalKeyHash
  if (existing.naturalKey !== draft.naturalKey)
    productPatch.naturalKey = draft.naturalKey
  if (existing.title !== draft.title) productPatch.title = draft.title
  if (existing.brand !== draft.brand) productPatch.brand = draft.brand
  if (existing.category !== draft.category)
    productPatch.category = draft.category
  if (existing.description !== draft.description)
    productPatch.description = draft.description
  if (existing.gtin !== draft.gtin) productPatch.gtin = draft.gtin
  if (existing.needsReview !== draft.needsReview)
    productPatch.needsReview = draft.needsReview
  if (existing.reviewReason !== draft.reviewReason)
    productPatch.reviewReason = draft.reviewReason
  if (Object.keys(productPatch).length > 0) {
    await tx
      .update(products)
      .set({ ...productPatch, updatedAt: new Date() })
      .where(eq(products.id, existing.id))
  }

  // English-text change on an adopted Product (ticket #15, GLOSSARY: Out of
  // Date): the enrichment's English copy is synced (no AI — that would be a
  // re-enrich), existing translations whose source hash no longer matches
  // are flagged Out of Date (manual Origin rows kept, never overwritten),
  // and the Product's AI translations re-run via its birth Import's
  // covering translate Jobs.
  const textPatch: Record<string, string> = {}
  for (const field of ["title", "description", "category"] as const) {
    const value = productPatch[field]
    if (typeof value === "string") textPatch[field] = value
  }
  if (Object.keys(textPatch).length > 0) {
    await flagTranslationsOutOfDate(tx, existing, textPatch)
  }

  const presentHashes = new Set<string>()
  const appended: VariantDraft[] = []
  for (const variant of draft.variants) {
    const variantKeyHash = keyHash(variant.variantKey)
    presentHashes.add(variantKeyHash)
    const current = existing.variants.get(variantKeyHash)
    if (!current) {
      appended.push(variant)
      continue
    }

    // Fast Path diff: price/weight-like fields (price) and supplier-fact
    // fields patch in place; identical fields issue nothing.
    const variantPatch: Record<string, unknown> = {}
    if (current.sku !== variant.sku) variantPatch.sku = variant.sku
    if (current.gtin !== variant.gtin) variantPatch.gtin = variant.gtin
    if (current.priceCents !== variant.priceCents)
      variantPatch.priceCents = variant.priceCents
    if (current.priceCurrency !== variant.priceCurrency)
      variantPatch.priceCurrency = variant.priceCurrency
    if (current.imageRef !== variant.imageRef)
      variantPatch.imageRef = variant.imageRef
    if (
      JSON.stringify(current.attributes) !== JSON.stringify(variant.attributes)
    )
      variantPatch.attributes = variant.attributes

    if (Object.keys(variantPatch).length > 0) {
      // The sheet that last contributed these values is this one.
      await tx
        .update(variants)
        .set({
          ...variantPatch,
          sourceRowIndex: variant.sourceRowIndex,
          importId,
          updatedAt: new Date(),
        })
        .where(eq(variants.id, current.id))
    }
    if (current.missingFromSource) {
      // Reappeared after being absent from an earlier re-import.
      await tx
        .update(variants)
        .set({
          missingFromSource: false,
          missingSince: null,
          updatedAt: new Date(),
        })
        .where(eq(variants.id, current.id))
    }
    variantKeyToLedger(
      draft,
      variant.variantKey,
      existing.id,
      current.id,
      writes
    )
  }

  if (appended.length > 0) {
    const upserted = await tx
      .insert(variants)
      .values(
        appended.map((variant) => ({
          storeId,
          importId,
          productId: existing.id,
          variantKey: variant.variantKey,
          variantKeyHash: keyHash(variant.variantKey),
          sku: variant.sku,
          gtin: variant.gtin,
          priceCents: variant.priceCents,
          priceCurrency: variant.priceCurrency,
          attributes: variant.attributes,
          imageRef: variant.imageRef,
          sourceRowIndex: variant.sourceRowIndex,
          needsReview: variant.needsReview,
          reviewReason: variant.reviewReason,
        }))
      )
      // A concurrent barrier may have appended the same Variant first —
      // converge onto its row (ADR-0003).
      .onConflictDoUpdate({
        target: [variants.productId, variants.variantKeyHash],
        set: {
          sku: sql`EXCLUDED.sku`,
          gtin: sql`EXCLUDED.gtin`,
          priceCents: sql`EXCLUDED.price_cents`,
          priceCurrency: sql`EXCLUDED.price_currency`,
          attributes: sql`EXCLUDED.attributes`,
          imageRef: sql`EXCLUDED.image_ref`,
          sourceRowIndex: sql`EXCLUDED.source_row_index`,
          needsReview: sql`EXCLUDED.needs_review`,
          reviewReason: sql`EXCLUDED.review_reason`,
          missingFromSource: sql`false`,
          missingSince: sql`null`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: variants.id, variantKeyHash: variants.variantKeyHash })
    for (const row of upserted) {
      const variant = appended.find(
        (candidate) => keyHash(candidate.variantKey) === row.variantKeyHash
      )
      if (variant)
        variantKeyToLedger(
          draft,
          variant.variantKey,
          existing.id,
          row.id,
          writes
        )
    }
  }

  // Variants of this Product the new sheet no longer carries.
  const absentHashes = [...existing.variants.keys()].filter(
    (hash) => !presentHashes.has(hash)
  )
  if (absentHashes.length > 0) {
    await tx
      .update(variants)
      .set({
        missingFromSource: true,
        missingSince: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(variants.productId, existing.id),
          inArray(variants.variantKeyHash, absentHashes),
          eq(variants.missingFromSource, false)
        )
      )
  }
}

/**
 * Out-of-Date tracking for an adopted Product whose English text changed
 * (ticket #15, GLOSSARY: Out of Date, Origin):
 *
 *   1. The enrichment's English copy is synced to the re-imported text —
 *      a field patch, not a re-enrichment: no provider call, no usage row,
 *      confidence/claims untouched. The translate Stage reads this copy as
 *      its source text, so the re-run translates the NEW English.
 *   2. Every translation of a CHANGED field is flagged `out_of_date` —
 *      deliberately conservative: the enrichment's English is a
 *      provider-formed copy, so the barrier cannot recompute the exact
 *      hash a translation must pin. Manual-Origin rows are kept verbatim —
 *      a translate upsert can never overwrite them (the
 *      `origin <> 'manual'` guard) — the flag is the merchant's signal.
 *      Over-flagging self-heals: the translate Stage clears the flag on
 *      any row whose hash still matches the live source text.
 *   3. AI re-runs happen for this Product only: the terminal translate
 *      Jobs of the Product's birth Import whose deterministic Batch covers
 *      it are requeued with reset attempts when AI work exists to redo.
 *      Unchanged Products in those Batches cost nothing (their
 *      translations still pin the current source hash — the translate
 *      handler skips them; Translation Memory absorbs anything else that
 *      was seen before).
 */
async function flagTranslationsOutOfDate(
  tx: CatalogTx,
  existing: FamilyProduct,
  textPatch: Record<string, string>
): Promise<void> {
  await tx
    .update(productEnrichments)
    .set({ ...textPatch, updatedAt: new Date() })
    .where(eq(productEnrichments.productId, existing.id))

  const changedFields = Object.keys(textPatch)
  await tx.execute(sql`
    UPDATE product_translations
    SET out_of_date = true, updated_at = now()
    WHERE product_id = ${existing.id}::uuid
      AND field IN (${sql.join(
        changedFields.map((field) => sql`${field}`),
        sql`, `
      )})
      AND NOT out_of_date
  `)

  const hasStaleAi = (await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM product_translations
      WHERE product_id = ${existing.id}::uuid
        AND origin = 'ai'
        AND field IN (${sql.join(
          changedFields.map((field) => sql`${field}`),
          sql`, `
        )})
    ) AS stale_ai
  `)) as unknown as Array<{ stale_ai: boolean }>
  const anyTranslations = (await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM product_translations
      WHERE product_id = ${existing.id}::uuid
    ) AS any_rows
  `)) as unknown as Array<{ any_rows: boolean }>
  // A Product with no translation rows at all gets the same re-run chance:
  // EC-088 no-ops (translation equal to source) write no row, so "no rows"
  // is not proof the new text needs nothing.
  if (!hasStaleAi[0]?.stale_ai && anyTranslations[0]?.any_rows) return

  // This Product's 1-based ordinal in its birth Import's deterministic
  // Batch order (ADR-0002) — the same order the planner and the translate
  // handler read.
  const ordinal = (await tx.execute(sql`
    SELECT ordinal FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY natural_key_hash) AS ordinal
      FROM products WHERE import_id = ${existing.importId}
    ) ranked
    WHERE ranked.id = ${existing.id}
  `)) as unknown as Array<{ ordinal: number }>
  const position = ordinal[0]?.ordinal
  if (!position) return

  const requeued = (await tx.execute(sql`
    UPDATE jobs SET
      status = 'pending',
      attempts = 0,
      lease_owner = NULL,
      lease_expires_at = NULL,
      available_at = NULL,
      updated_at = now()
    WHERE import_id = ${existing.importId}
      AND stage = 'translate'
      AND status IN ('completed', 'failed')
      AND batch_key ~ '^products-[0-9]{6}-[0-9]{6}'
      AND (regexp_match(
            batch_key, '^products-([0-9]{6})-([0-9]{6})'
          ))[1]::int <= ${position}
      AND (regexp_match(
            batch_key, '^products-([0-9]{6})-([0-9]{6})'
          ))[2]::int >= ${position}
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  if (requeued.length > 0) {
    log.info(`requeued translate jobs for out-of-date product`, {
      productId: existing.id,
      importId: existing.importId,
      jobIds: requeued.map((row) => row.id),
    })
  }
}

/**
 * Land the Row Ledger: one row per Sheet Row, terminal state Done /
 * Needs Review / Failed with a reason (GLOSSARY: Row Ledger). Upsert on
 * (import, row_index) — a redelivered barrier rewrites the same states.
 */
async function writeLedger(
  db: Database,
  storeId: string,
  importId: string,
  rows: SourceRow[],
  neverCleaned: number[],
  ledgerProductId: Map<number, string>,
  ledgerVariantId: Map<number, string>,
  reviewByRowIndex: Map<number, boolean>
): Promise<void> {
  const entries: Array<{
    rowIndex: number
    state: "done" | "needs_review" | "failed"
    productId: string | null
    variantId: string | null
    failureReason: string | null
    failureEc: string | null
  }> = []
  for (const rowIndex of neverCleaned) {
    entries.push({
      rowIndex,
      state: "failed",
      productId: null,
      variantId: null,
      failureReason: NEVER_CLEANED_REASON,
      failureEc: null,
    })
  }
  for (const row of rows) {
    const productId = ledgerProductId.get(row.rowIndex) ?? null
    const variantId = ledgerVariantId.get(row.rowIndex) ?? null
    if (productId === null) {
      entries.push({
        rowIndex: row.rowIndex,
        state: "failed",
        productId: null,
        variantId: null,
        failureReason: NO_IDENTITY_REASON,
        failureEc: "EC-031",
      })
      continue
    }
    entries.push({
      rowIndex: row.rowIndex,
      // Needs Review mirrors the Product/Variant quality state (GLOSSARY).
      state: reviewByRowIndex.get(row.rowIndex) ? "needs_review" : "done",
      productId,
      variantId,
      failureReason: null,
      failureEc: null,
    })
  }

  for (let index = 0; index < entries.length; index += UPSERT_BATCH) {
    const batch = entries.slice(index, index + UPSERT_BATCH)
    await db
      .insert(rowLedger)
      .values(batch.map((entry) => ({ storeId, importId, ...entry })))
      .onConflictDoUpdate({
        target: [rowLedger.importId, rowLedger.rowIndex],
        set: {
          state: sql`EXCLUDED.state`,
          productId: sql`EXCLUDED.product_id`,
          variantId: sql`EXCLUDED.variant_id`,
          failureReason: sql`EXCLUDED.failure_reason`,
          failureEc: sql`EXCLUDED.failure_ec`,
          updatedAt: new Date(),
        },
      })
  }
}
