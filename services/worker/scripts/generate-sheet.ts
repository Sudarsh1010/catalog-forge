/**
 * Synthetic messy supplier sheet — the 10,000-row scale fixture (spec user
 * story 29 / Ticket 6) that doubles as the sample-data deliverable.
 *
 * Deterministic under a seed (same seed → byte-identical sheet). The mess
 * is the reference scenario: mixed price formats (`1.299,00 €`, `12.5`,
 * `£8`, bare integers, blanks), mixed units (cm/inch, kg/lbs), colour
 * typos, HTML in descriptions, split/duplicated rows for the same product,
 * rows without a supplier code, and NBSP/space noise — every EC class the
 * clean/group stages advertise as handled.
 *
 * CLI: tsx scripts/generate-sheet.ts [rows=10000] [outfile]
 */
import { writeFileSync } from "node:fs"

export interface GeneratedSheet {
  header: string[]
  rows: string[][]
}

export const SHEET_HEADER = [
  "SKU",
  "Title",
  "Brand",
  "Category",
  "Description",
  "Price",
  "EAN",
  "Farbe",
  "Size",
]

/** Tiny seeded PRNG (mulberry32) — deterministic chaos needs deterministic mess. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BRANDS = [
  "Brunner",
  "Gardena",
  "Westfalia",
  "Terrakotta Werk",
  "Nordwind",
]
const CATEGORIES = [
  "Garden > Watering",
  "Garden > Plant Pots",
  "Garden > Tools",
  "Home > Storage",
  "Workshop > Fasteners",
]
const COLOURS = [
  "rot",
  "blau",
  "grün",
  "terracota", // EC-054: the typo is the point
  "anthrazit",
  "creme weiß",
]
const SIZES = ["S", "M", "L", "XL", "one size"]
const POT_SIZES = ['Ø 19,6"', "Ø 50 cm", "Ø 30 cm", "40 x 30 x 20 cm"]
const WEIGHTS = ["5 kg", "2 lbs", "500 g", "1,2 kg", "12,5 kg"]
const PRODUCT_NOUNS = [
  "Watering pot",
  "Plant pot",
  "Garden scoop",
  "Storage box",
  "Wall hook",
  "Plant saucer",
  "Trowel",
  "Compost bin",
]

/** Rotating price formats — the de/en ambiguity zoo (EC-038/EC-039). */
function priceFormat(value: number, roll: number): string {
  const euros = Math.floor(value)
  const cents = Math.round((value - euros) * 100)
  const de = `${euros.toLocaleString("de-DE")},${String(cents).padStart(2, "0")} €`
  switch (roll % 8) {
    case 0:
      return de
    case 1:
      return `${value.toFixed(2)}` // en-style plain decimal
    case 2:
      return `£${euros}` // bare pounds, foreign symbol in a € column
    case 3:
      return String(euros) // integer, no decimals
    case 4:
      return "" // blank — price missing, EC-040
    case 5:
      return `${euros}.${cents}` // en decimal point with cents
    case 6:
      return `${euros.toLocaleString("de-DE")},${String(cents).padStart(2, "0")}` // de, no symbol
    default:
      return `${value.toFixed(1)}` // one decimal digit (12.5)
  }
}

function description(
  noun: string,
  size: string,
  weight: string,
  roll: number
): string {
  const core = `Durable ${noun.toLowerCase()} made of steel, ${size}, ${weight}. For indoor and outdoor use.`
  switch (roll % 6) {
    case 0:
      return `<p>${core}</p>` // EC-056: HTML arrives from the supplier
    case 1:
      return `<p>Durable ${noun.toLowerCase()}.</p><b>${size}</b> ${weight}`
    case 2:
      return core.replaceAll(" ", "\u00A0") // NBSP noise (EC-057)
    case 3:
      return `  ${core}  ` // surrounding whitespace
    case 4:
      return core.toUpperCase() // EC-059 formatting noise
    default:
      return core
  }
}

function ean13(rng: () => number): string {
  let digits = ""
  for (let i = 0; i < 12; i++) digits += String(Math.floor(rng() * 10))
  const sum = [...digits].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0
  )
  return `${digits}${(10 - (sum % 10)) % 10}`
}

/** Serialize to RFC4180 CSV bytes (quoted where needed). */
export function toCsv(sheet: GeneratedSheet): string {
  const quote = (cell: string): string =>
    /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
  return (
    [sheet.header, ...sheet.rows]
      .map((row) => row.map(quote).join(","))
      .join("\r\n") + "\r\n"
  )
}

/**
 * Generate `rowCount` messy data rows. Shape (deterministic by seed):
 *  ~90% normal rows, ~5% split/variant rows repeating an earlier product
 *  family with a new colour (EC-060/EC-061), ~3% rows without a supplier
 *  code (EC-031 title identity), ~2% exact duplicates of earlier rows.
 */
export function generateSheet(rowCount: number, seed = 42): GeneratedSheet {
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error(`rowCount must be a positive integer, got ${rowCount}`)
  }
  const rng = mulberry32(seed)
  const rows: string[][] = []
  /** Product families already emitted, for split/duplicate rows. */
  const families: Array<{ sku: string; row: string[] }> = []

  for (let index = 1; index <= rowCount; index++) {
    const roll = rng()
    const familyRoll = rng()

    if (roll < 0.02 && families.length > 0) {
      // Exact duplicate of an earlier row (EC-009/EC-061 export ran twice).
      const source = families[Math.floor(familyRoll * families.length)]!
      rows.push([...source.row])
      continue
    }

    if (roll < 0.07 && families.length > 0) {
      // Split row: same product family, another colour — scattered later
      // in the file (EC-060). SKU family base + variant suffix.
      const source = families[Math.floor(familyRoll * families.length)]!
      const colour = COLOURS[Math.floor(rng() * COLOURS.length)]!
      rows.push([
        `${source.sku}-${colour.slice(0, 1).toUpperCase()}`,
        source.row[1]!,
        source.row[2]!,
        source.row[3]!,
        source.row[4]!,
        priceFormat(10 + rng() * 90, Math.floor(rng() * 8)),
        ean13(rng),
        colour,
        source.row[8]!,
      ])
      continue
    }

    const noun = PRODUCT_NOUNS[Math.floor(rng() * PRODUCT_NOUNS.length)]!
    const size = roll < 0.12 ? "" : SIZES[Math.floor(rng() * SIZES.length)]!
    const potSize = POT_SIZES[Math.floor(rng() * POT_SIZES.length)]!
    const weight = WEIGHTS[Math.floor(rng() * WEIGHTS.length)]!
    const row: string[] = [
      roll < 0.1 ? "" : `SKU-${String(index).padStart(5, "0")}`, // EC-031: some rows have no code
      roll < 0.04
        ? `${noun} ${potSize}` // unit embedded in the title (EC-048)
        : `${noun} ${size || potSize}`,
      BRANDS[Math.floor(rng() * BRANDS.length)]!,
      CATEGORIES[Math.floor(rng() * CATEGORIES.length)]!,
      description(noun, potSize, weight, Math.floor(rng() * 6)),
      priceFormat(3 + rng() * 300, Math.floor(rng() * 8)),
      roll < 0.15 ? "" : ean13(rng),
      COLOURS[Math.floor(rng() * COLOURS.length)]!,
      size,
    ]
    rows.push(row)
    if (row[0] !== "") families.push({ sku: row[0]!, row })
  }
  return { header: SHEET_HEADER, rows }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\u0000")
if (isMain) {
  const rowCount = Number.parseInt(process.argv[2] ?? "10000", 10)
  const outfile = process.argv[3]
  const sheet = generateSheet(rowCount)
  const csv = toCsv(sheet)
  if (outfile) {
    writeFileSync(outfile, csv, "utf8")
    console.log(
      `wrote ${rowCount} data rows → ${outfile} (${csv.length} bytes)`
    )
  } else {
    process.stdout.write(csv)
  }
}
