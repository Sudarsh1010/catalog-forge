/**
 * The `group` Barrier Stage handler: ONE Job observes ALL cleaned rows of
 * the Import and collapses them into Products and Variants on scoped
 * Natural Keys — duplicated, split and out-of-order rows converge (EC-033,
 * EC-060, EC-061), identity is folded through NFC/invisible/case keys
 * (EC-034, EC-035), and the Natural Key is scoped to the Import so the same
 * supplier code from two sources stays two Products (EC-032).
 *
 * The Row Ledger links every Sheet Row to its Product or its failure reason
 * — the only source of "the counts add up" (GLOSSARY: Row Ledger).
 *
 * Idempotent by construction (ADR-0003): Products upsert on
 * (store, import, natural-key hash) — EC-068's database guarantee, racing
 * workers included — Variants on (product, variant-key hash), and ledger
 * rows on (import, row_index); a re-delivered barrier converges with zero
 * duplicates. Stage advancement and the enrich/translate fan-out happen in
 * the Job machinery's completion transaction, not here.
 */
import { eq, sql } from "drizzle-orm"

import type { Database } from "@workspace/db"
import type { CleanColumnPlan, CleanedCell } from "@workspace/db/schema"
import {
  cleanPlans,
  imports,
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
    // whose clean chunk died land in the ledger as Failed (accounting).
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
      await writeCatalog(db, imp.storeId, job.importId, drafts)

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

/**
 * Upsert Products → Variants → return the id maps the ledger needs. All in
 * one transaction: a redelivered barrier either lands the whole catalog
 * update or none of it, and the unique indexes (EC-068) make concurrent
 * duplicates impossible regardless.
 */
async function writeCatalog(
  db: Database,
  storeId: string,
  importId: string,
  drafts: ProductDraft[]
): Promise<CatalogWrites> {
  const ledgerProductId = new Map<number, string>()
  const ledgerVariantId = new Map<number, string>()
  const reviewByRowIndex = new Map<number, boolean>()
  if (drafts.length === 0) {
    return { ledgerProductId, ledgerVariantId, reviewByRowIndex }
  }

  await db.transaction(async (tx) => {
    const productIdByHash = new Map<string, string>()
    for (let index = 0; index < drafts.length; index += UPSERT_BATCH) {
      const batch = drafts.slice(index, index + UPSERT_BATCH)
      const upserted = await tx
        .insert(products)
        .values(
          batch.map((draft) => ({
            storeId,
            importId,
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
            products.importId,
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

    const variantIdByKey = new Map<string, string>()
    const variantDrafts = drafts.flatMap((draft) =>
      draft.variants.map((variant) => ({
        draft,
        variant,
        productId: productIdByHash.get(draft.naturalKeyHash)!,
      }))
    )
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

    // Row → Product/Variant resolution for the ledger write.
    const variantKeyToId = new Map<string, string>()
    for (const draft of drafts) {
      const productId = productIdByHash.get(draft.naturalKeyHash)!
      for (const variant of draft.variants) {
        const id = variantIdByKey.get(
          `${productId}:${keyHash(variant.variantKey)}`
        )
        if (id) variantKeyToId.set(`${productId}|${variant.variantKey}`, id)
      }
    }
    for (const draft of drafts) {
      const productId = productIdByHash.get(draft.naturalKeyHash)!
      for (const member of draft.memberRows) {
        const variantId = variantKeyToId.get(
          `${productId}|${member.variantKey}`
        )
        if (!variantId) continue
        ledgerProductId.set(member.rowIndex, productId)
        ledgerVariantId.set(member.rowIndex, variantId)
        const variant = draft.variants.find(
          (candidate) => candidate.variantKey === member.variantKey
        )
        reviewByRowIndex.set(
          member.rowIndex,
          draft.needsReview || (variant?.needsReview ?? false)
        )
      }
    }
  })

  return { ledgerProductId, ledgerVariantId, reviewByRowIndex }
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
