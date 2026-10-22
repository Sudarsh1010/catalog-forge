/**
 * Eval Set Layer 2 scoring (Ticket #20 / spec #11): AI-enriched field
 * accuracy (title, category, tags, claims) over a sample of the Eval Set,
 * graded loosely — valid output varies, so exact match is the wrong bar:
 *
 *   title     semantic-ish token similarity against the gold title (F1 ≥ 0.6)
 *   category  fuzzy match against the sheet's own Kategorie values for the
 *             Product's source rows (normalized containment/Jaccard ≥ 0.5)
 *   tags      every tag must trace back to the Product's source Sheet Rows
 *             (loose token coverage ≥ 0.6); an invented tag is an error
 *   claims    EC-075 traceability: every predicted Claim must cite a
 *             sourceRowIndex inside the Product's sourceRows AND its text
 *             must be grounded in that row's cells — a Claim the source does
 *             not support is an ERROR. Where gold Claims exist they must be
 *             covered (loose token match).
 *
 * Requires a real provider: OPENAI_API_KEY must be set (two-tier
 * gpt-4o-mini/gpt-4o registry, exactly what the worker runs in production).
 * Without a key the script refuses to run — Layer 2 numbers without a real
 * provider would be Demo Mode numbers wearing a Layer 2 label.
 *
 * Run: `pnpm --filter @workspace/worker eval:l2`
 * (`OPENAI_API_KEY=sk-… EVAL_L2_SAMPLE=12` — sample size defaults to 12).
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { openAIProviderEntries } from "../src/provider/openai.js"
import {
  runEvalPipeline,
  scoreLayer1,
  type CleanedRow,
  type EvalRun,
  type GoldProduct,
} from "./eval-pipeline.js"

export type { CleanedRow, EvalRun, GoldProduct } from "./eval-pipeline.js"

// ------------------------------------------------------------ loose matching --

/** Lowercase, fold umlauts, drop punctuation → informative tokens. */
const STOP_TOKENS = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "und",
  "oder",
  "mit",
  "fur",
  "fuer",
  "aus",
  "im",
  "in",
  "von",
  "the",
  "and",
  "cm",
  "mm",
  "ca",
])

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_TOKENS.has(token))
}

/** Token-set F1: harmonic mean of precision and recall vs the gold tokens. */
function tokenF1(predicted: string[], gold: string[]): number {
  if (predicted.length === 0 || gold.length === 0) return 0
  const predictedSet = new Set(predicted)
  const goldSet = new Set(gold)
  let overlap = 0
  for (const token of predictedSet) if (goldSet.has(token)) overlap += 1
  const precision = overlap / predictedSet.size
  const recall = overlap / goldSet.size
  if (precision + recall === 0) return 0
  return (2 * precision * recall) / (precision + recall)
}

/** Loose title bar: ≥ 0.6 token F1 counts as a semantic match. */
const TITLE_F1_THRESHOLD = 0.6

export function titleMatches(predicted: string, gold: string): boolean {
  return tokenF1(tokens(predicted), tokens(gold)) >= TITLE_F1_THRESHOLD
}

/**
 * Loose category bar: normalized containment (predicted ⊆ gold or gold ⊆
 * predicted, category paths like "Garten > Gießen") or Jaccard ≥ 0.5.
 */
export function categoryMatches(predicted: string, gold: string): boolean {
  const p = tokens(predicted)
  const g = tokens(gold)
  if (p.length === 0 || g.length === 0) return false
  const pSet = new Set(p)
  const gSet = new Set(g)
  let overlap = 0
  for (const token of pSet) if (gSet.has(token)) overlap += 1
  const contained = overlap === pSet.size || overlap === gSet.size
  if (contained) return true
  const union = new Set([...pSet, ...gSet]).size
  return overlap / union >= 0.5
}

/**
 * Fraction of `text`'s informative tokens that appear in `haystack` — the
 * grounding test for tags and Claims against the raw Sheet Row cells.
 */
function tokenCoverage(text: string, haystack: string): number {
  const needles = tokens(text)
  if (needles.length === 0) return 1 // nothing to ground: vacuously traceable
  const hay = new Set(tokens(haystack))
  let covered = 0
  for (const token of needles) if (hay.has(token)) covered += 1
  return covered / needles.length
}

/** Loose grounding bar: ≥ 0.6 of a Claim/tag's tokens must appear in source. */
const GROUNDING_THRESHOLD = 0.6

// ----------------------------------------------------------------- scoring --

export interface ProductGrade {
  id: string
  title: boolean
  category: boolean
  tags: boolean
  claims: boolean
  /** Human-readable reasons for each false field. */
  failures: string[]
}

/** The Product's source-row cell texts, joined — the grounding haystack. */
export function sourceTextFor(
  run: EvalRun,
  sourceRows: number[],
  rowIndex: number | null
): string {
  const cleanedByRow = new Map(run.cleaned.map((row) => [row.row_index, row]))
  const rows = rowIndex === null ? sourceRows : [rowIndex]
  const texts: string[] = []
  for (const row of rows) {
    const cleaned: CleanedRow | undefined = cleanedByRow.get(row)
    if (cleaned === undefined) continue
    for (const cell of cleaned.values) {
      if (cell === null) continue
      if (cell.kind === "quantity" && "value" in cell) {
        texts.push(String(cell.value))
        continue
      }
      const value = "value" in cell ? cell.value : undefined
      if (typeof value === "string") texts.push(value)
    }
  }
  return texts.join(" ")
}

/**
 * The gold category for one Product: the most common non-empty Kategorie
 * cell across its source Sheet Rows (the sheet's own taxonomy).
 */
export function goldCategory(
  run: EvalRun,
  sourceRows: number[],
  categoryName = "Kategorie"
): string {
  const columnIndex = run.header.indexOf(categoryName)
  if (columnIndex < 0) return ""
  const cleanedByRow = new Map(run.cleaned.map((row) => [row.row_index, row]))
  const counts = new Map<string, number>()
  for (const row of sourceRows) {
    const cleaned = cleanedByRow.get(row)
    const cell = cleaned !== undefined ? cleaned.values[columnIndex] : undefined
    const cellValue =
      cell !== undefined && cell !== null && "value" in cell
        ? cell.value
        : undefined
    if (typeof cellValue === "string" && cellValue.trim() !== "") {
      counts.set(cellValue, (counts.get(cellValue) ?? 0) + 1)
    }
  }
  let best = ""
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Grade one sampled gold Product's AI-enriched fields against its predicted
 * enrichment. Every loose-grading rule above applies; Claim traceability
 * failures are hard errors (EC-075), never partially credited.
 */
export function gradeProduct(
  run: EvalRun,
  gp: GoldProduct,
  predicted: {
    title: string
    category: string
    tags: string[]
    claims: Array<{
      text: string
      sourceRowIndex: number
      sourceColumn?: string
    }>
  },
  /** Sheet header carrying the gold category ("Kategorie" in the Eval Set). */
  categoryColumn = "Kategorie"
): ProductGrade {
  const failures: string[] = []

  const titleOk = titleMatches(predicted.title, gp.title)
  if (!titleOk)
    failures.push(`title: "${predicted.title}" vs gold "${gp.title}"`)

  const categoryGold = goldCategory(run, gp.sourceRows, categoryColumn)
  // No gold category in the sheet → the field is unverifiable, never a miss.
  const categoryOk =
    categoryGold === ""
      ? true
      : categoryMatches(predicted.category, categoryGold)
  if (!categoryOk)
    failures.push(`category: "${predicted.category}" vs gold "${categoryGold}"`)

  // Tags: every tag must trace to the Product's source rows.
  const allSourceText = sourceTextFor(run, gp.sourceRows, null)
  const tagFailures: string[] = []
  for (const tag of predicted.tags) {
    if (tokenCoverage(tag, allSourceText) < GROUNDING_THRESHOLD)
      tagFailures.push(tag)
  }
  const tagsOk = tagFailures.length === 0
  if (!tagsOk) failures.push(`tags ungrounded: ${tagFailures.join(", ")}`)

  // Claims: traceability is an error, not a similarity penalty (EC-075).
  const claimFailures: string[] = []
  for (const claim of predicted.claims) {
    const inProduct = gp.sourceRows.includes(claim.sourceRowIndex)
    const rowText = inProduct
      ? sourceTextFor(run, gp.sourceRows, claim.sourceRowIndex)
      : ""
    if (!inProduct || tokenCoverage(claim.text, rowText) < GROUNDING_THRESHOLD)
      claimFailures.push(
        `"${claim.text}" (row ${claim.sourceRowIndex}${inProduct ? "" : " not in sourceRows"})`
      )
  }
  // Gold Claims must be covered by some predicted Claim (loose match).
  if (gp.claims !== undefined) {
    for (const goldClaim of gp.claims) {
      const covered = predicted.claims.some(
        (claim) => tokenCoverage(claim.text, goldClaim) >= GROUNDING_THRESHOLD
      )
      if (!covered) claimFailures.push(`gold claim missed: "${goldClaim}"`)
    }
  }
  const claimsOk = claimFailures.length === 0
  if (!claimsOk) failures.push(`claims: ${claimFailures.join("; ")}`)

  return {
    id: gp.id,
    title: titleOk,
    category: categoryOk,
    tags: tagsOk,
    claims: claimsOk,
    failures,
  }
}

/**
 * The Layer 2 sample: gold Products carrying gold Claims first (they stress
 * traceability), then the rest, deterministically by id. Size:
 * EVAL_L2_SAMPLE, default 12 — the real provider bills per call.
 */
export function sampleProducts(gold: GoldProduct[]): GoldProduct[] {
  const size = Number(process.env.EVAL_L2_SAMPLE ?? 12)
  const withClaims = gold
    .filter((gp) => (gp.claims?.length ?? 0) > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
  const rest = gold
    .filter((gp) => (gp.claims?.length ?? 0) === 0)
    .sort((a, b) => a.id.localeCompare(b.id))
  return [...withClaims, ...rest].slice(0, size)
}

// -------------------------------------------------------------------- main --

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey === "") {
    console.error(
      "Layer 2 requires a real provider: set OPENAI_API_KEY (enrichment runs gpt-4o-mini/gpt-4o over the Eval sample)."
    )
    process.exitCode = 1
    return
  }

  const concurrency = Number(process.env.EVAL_L2_CONCURRENCY ?? 4)
  const run = await runEvalPipeline({
    providerEntries: openAIProviderEntries({ apiKey, concurrency }),
  })
  const layer1 = scoreLayer1(run)

  const byProduct = new Map(
    run.enrichments.map((enrichment) => [enrichment.product_id, enrichment])
  )
  const rowsByProduct = new Map(
    run.enrichments.map((enrichment) => [
      enrichment.product_id,
      new Set(enrichment.source_row_indexes),
    ])
  )
  // Match gold Products to predicted enrichments via source-row sets (the
  // same relation Layer 1's grouping scorer uses).
  const rowToProductId = new Map<number, string>()
  for (const [productId, rows] of rowsByProduct) {
    for (const row of rows) rowToProductId.set(row, productId)
  }

  const sample = sampleProducts(run.gold.products)
  const grades: ProductGrade[] = []
  for (const gp of sample) {
    const productId = rowToProductId.get(gp.sourceRows[0]!)
    const enrichment =
      productId !== undefined ? byProduct.get(productId) : undefined
    if (enrichment === undefined) {
      grades.push({
        id: gp.id,
        title: false,
        category: false,
        tags: false,
        claims: false,
        failures: ["no enrichment output (grouping missed this Product)"],
      })
      continue
    }
    grades.push(
      gradeProduct(run, gp, {
        title: enrichment.title,
        category: enrichment.category,
        tags: enrichment.tags,
        claims: enrichment.claims,
      })
    )
  }

  const tally = (field: "title" | "category" | "tags" | "claims") =>
    grades.reduce<[number, number]>(
      (acc, grade) =>
        grade[field] ? [acc[0] + 1, acc[1] + 1] : [acc[0], acc[1] + 1],
      [0, 0]
    )
  const pct = ([hit, total]: [number, number]): string =>
    total === 0
      ? "n/a"
      : `${((100 * hit) / total).toFixed(1)}% (${hit}/${total})`

  console.log("=== Eval Set — Layer 1 (same run, real provider) ===")
  for (const [field, score] of Object.entries(layer1.scores)) {
    console.log(`${field.padEnd(14)}: ${pct(score)}`)
  }
  console.log(
    "\n=== Eval Set — Layer 2 (AI-enriched fields, real provider) ==="
  )
  console.log(`sample: ${grades.length} gold Products`)
  console.log(`title         : ${pct(tally("title"))}`)
  console.log(`category      : ${pct(tally("category"))}`)
  console.log(`tags          : ${pct(tally("tags"))}`)
  console.log(`claims        : ${pct(tally("claims"))}`)

  const failed = grades.filter((grade) => grade.failures.length > 0)
  if (failed.length > 0) {
    console.log("\n-- Layer 2 failures:")
    for (const grade of failed) {
      console.log(`  ${grade.id}:\n    ${grade.failures.join("\n    ")}`)
    }
  }
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
