/**
 * Semantic column roles for the group Barrier Stage: which cleaned column
 * carries the supplier code, the title, the brand, … and which leftover text
 * columns are variant axes (EC-063).
 *
 * The mapping is deterministic header-hint matching over the clean Stage's
 * column plan — every column gets at most one role, first match wins in the
 * fixed priority below; unconsumed text columns become variant attributes.
 */
import type { CleanColumnPlan } from "@workspace/db/schema"

export interface ColumnRoles {
  /** Supplier code column (SKU/article number), or `null`. */
  skuIndex: number | null
  /** Dedicated GTIN/EAN/UPC column, or `null`. */
  gtinIndex: number | null
  /** Product title column, or `null`. */
  titleIndex: number | null
  brandIndex: number | null
  categoryIndex: number | null
  descriptionIndex: number | null
  /** The sheet's image-reference column (EC-072), or `null`. */
  imageRefIndex: number | null
  /** First price-kind column (Variant price, EC-021). */
  priceIndex: number | null
  /** Remaining text columns, header order — the variant axes (EC-063). */
  attributeIndexes: number[]
}

// Priority order matters: a column named "EAN" is first a supplier code
// candidate slot, then a GTIN column; "Artikelname" must not eat "Beschreibung".
const SKU_HEADER =
  /(sku|art[-_. ]?nr|artikelnr|artikelnummer|artikel[-_. ]?nr|article[-_. ]?(no|number|code)|item[-_. ]?(no|number|code)|bestellnr|bestellnummer|lieferanten[-_. ]?(sku|nr|nummer)|supplier[-_. ]?(sku|code)|modell|model[-_. ]?(no|number))/i
const GTIN_HEADER = /(^|[^a-z])(gtin|ean|upc|barcode)([^a-z]|$)/i
const TITLE_HEADER =
  /(^|[^a-z])(titel|title|name|produktname|product[-_. ]?name|artikelname|bezeichnung)([^a-z]|$)/i
const BRAND_HEADER = /(brand|marke|hersteller|manufacturer|marque)/i
const CATEGORY_HEADER = /(category|kategorie|rubrik|warengruppe)/i
const DESCRIPTION_HEADER =
  /(description|beschreibung|langtext|details?)([^a-z]|$)/i
const IMAGE_HEADER =
  /(image|bild|foto|photo|img|picture|bildref|bild[-_. ]?datei|bild[-_. ]?name|dateiname)/i

/**
 * Map the Import's header (aligned with the cleaned cell arrays) to semantic
 * roles under the clean plan's column kinds.
 */
export function mapColumns(
  header: string[],
  columns: CleanColumnPlan[]
): ColumnRoles {
  const roles: ColumnRoles = {
    skuIndex: null,
    gtinIndex: null,
    titleIndex: null,
    brandIndex: null,
    categoryIndex: null,
    descriptionIndex: null,
    imageRefIndex: null,
    priceIndex: null,
    attributeIndexes: [],
  }
  const consumed = new Set<number>()

  for (let index = 0; index < header.length; index++) {
    const name = header[index] ?? ""
    if (roles.skuIndex === null && SKU_HEADER.test(name)) {
      roles.skuIndex = index
      consumed.add(index)
      continue
    }
    if (roles.gtinIndex === null && GTIN_HEADER.test(name)) {
      roles.gtinIndex = index
      consumed.add(index)
      continue
    }
    if (roles.imageRefIndex === null && IMAGE_HEADER.test(name)) {
      roles.imageRefIndex = index
      consumed.add(index)
      continue
    }
    if (roles.titleIndex === null && TITLE_HEADER.test(name)) {
      roles.titleIndex = index
      consumed.add(index)
      continue
    }
    if (roles.brandIndex === null && BRAND_HEADER.test(name)) {
      roles.brandIndex = index
      consumed.add(index)
      continue
    }
    if (roles.categoryIndex === null && CATEGORY_HEADER.test(name)) {
      roles.categoryIndex = index
      consumed.add(index)
      continue
    }
    if (roles.descriptionIndex === null && DESCRIPTION_HEADER.test(name)) {
      roles.descriptionIndex = index
      consumed.add(index)
      continue
    }
  }

  // First price-kind column carries the Variant price; further price columns
  // (UVP & friends) stay unmapped for now — documented limitation.
  roles.priceIndex =
    columns.find((column) => column.kind === "price")?.index ?? null

  for (let index = 0; index < header.length; index++) {
    if (consumed.has(index)) continue
    if (index === roles.priceIndex) continue
    if (columns[index]?.kind === "text") roles.attributeIndexes.push(index)
  }
  return roles
}
