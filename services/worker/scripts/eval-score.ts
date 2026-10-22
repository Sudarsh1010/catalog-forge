/**
 * Eval Set Layer 1 scoring (Ticket 13 / spec #11 user story 30–31).
 *
 * Seeds the Eval Set (eval/supplier-sheet.csv + photos) into a throwaway
 * `catalog_forge_eval` database, runs the full pipeline in Demo Mode
 * (keyless, stub provider) and scores the structured fields exactly against
 * eval/gold-labels.json:
 *
 *   grouping   rows → Products (exact set match)
 *   dedupe     Variant count per matched Product
 *   price      cents + currency per gold Variant
 *   units      canonical mm/g/ml per cleaned quantity cell
 *   photos     matched / Parked per gold entry
 *   review     Needs Review flag per matched Product
 *
 * CI gate: eval/thresholds.json floors per field — any regression fails the
 * run. Layer 2 (AI-enriched fields, real provider) lives in
 * scripts/eval-score-l2.ts.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { EVAL_DIR, runEvalPipeline, scoreLayer1 } from "./eval-pipeline.js"

async function main(): Promise<void> {
  const run = await runEvalPipeline()
  const { gold, cleaned } = run
  const layer1 = scoreLayer1(run)

  // CI gate: the recorded baseline (eval/thresholds.json) is the floor.
  // A regression on any Layer 1 field fails the run.
  const thresholds = JSON.parse(
    readFileSync(path.join(EVAL_DIR, "thresholds.json"), "utf8")
  ) as Record<string, { hit: number; total: number }>
  let regressed = false
  for (const [field, [hit, total]] of Object.entries(layer1.scores)) {
    const floor = thresholds[field]
    if (floor !== undefined && hit < floor.hit) {
      console.error(
        `REGRESSION ${field}: ${hit}/${total} below baseline floor ${floor.hit}/${floor.total}`
      )
      regressed = true
    }
  }
  if (regressed) process.exitCode = 1

  const pct = (hit: number, total: number): string =>
    total === 0
      ? "n/a"
      : `${((100 * hit) / total).toFixed(1)}% (${hit}/${total})`

  console.log("=== Eval Set — Layer 1 (Demo Mode, keyless) ===")
  console.log(
    `sheet rows: ${cleaned.length}, gold products: ${gold.products.length}, gold variants: ${gold.products.reduce((sum, gp) => sum + gp.variants.length, 0)}`
  )
  console.log(
    `grouping      : ${pct(...layer1.scores.grouping!)} (extra products: ${layer1.extraProducts})`
  )
  console.log(`dedupe        : ${pct(...layer1.scores.dedupe!)}`)
  console.log(`price cents   : ${pct(...layer1.scores.price!)}`)
  console.log(`units         : ${pct(...layer1.scores.units!)}`)
  console.log(
    `photo matching: ${pct(...layer1.scores.photos!)} (extra parked: ${layer1.extraParked}, extra matched: ${layer1.extraMatched})`
  )
  console.log(`review status : ${pct(...layer1.scores.review!)}`)
  for (const [field, list] of Object.entries(layer1.misses)) {
    if (list.length > 0)
      console.log(`\n-- ${field} misses:\n  ${list.slice(0, 40).join("\n  ")}`)
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
