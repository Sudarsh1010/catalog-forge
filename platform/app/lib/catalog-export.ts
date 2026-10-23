/**
 * CSV and JSON serialization for the catalog export routes (ticket #18).
 * Both formats carry the exact `ProductListRow` projection the Products
 * tab shows: the CSV is flat with composite fields JSON-encoded, the JSON
 * payload is the DTO array itself.
 */
import type { ProductListRow } from "@workspace/contracts"

/**
 * RFC 4180 cells: quote when the value contains a comma, double quote or
 * line break, doubling embedded quotes.
 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * The export columns — every ProductListRow field, headers named after
 * the DTO keys so the CSV and JSON exports align. Composite values
 * (arrays, the confidence map) are JSON-encoded into the cell; `null`
 * collapses to an empty cell.
 */
const CSV_COLUMNS: Array<{
  header: string
  cell: (row: ProductListRow) => string
}> = [
  { header: "id", cell: (row) => row.id },
  { header: "importId", cell: (row) => row.importId },
  { header: "importFilename", cell: (row) => row.importFilename },
  { header: "naturalKey", cell: (row) => row.naturalKey },
  { header: "title", cell: (row) => row.title },
  { header: "handle", cell: (row) => row.handle ?? "" },
  { header: "status", cell: (row) => row.status },
  { header: "reviewReasons", cell: (row) => JSON.stringify(row.reviewReasons) },
  { header: "confidence", cell: (row) => JSON.stringify(row.confidence) },
  {
    header: "minConfidence",
    cell: (row) =>
      row.minConfidence === null ? "" : String(row.minConfidence),
  },
  {
    header: "messiness",
    cell: (row) => (row.messiness === null ? "" : String(row.messiness)),
  },
  { header: "sourceRowCount", cell: (row) => String(row.sourceRowCount) },
  { header: "photoCount", cell: (row) => String(row.photoCount) },
  { header: "editedByMerchant", cell: (row) => String(row.editedByMerchant) },
  {
    header: "publishedLocales",
    cell: (row) => JSON.stringify(row.publishedLocales),
  },
  { header: "updatedAt", cell: (row) => row.updatedAt },
]

/**
 * The catalog as RFC 4180 CSV: CRLF line breaks and a UTF-8 BOM so
 * spreadsheet applications decode the non-ASCII catalog text (ü, é, …)
 * correctly.
 */
export function catalogCsv(rows: ProductListRow[]): string {
  const lines = [
    CSV_COLUMNS.map((column) => column.header),
    ...rows.map((row) => CSV_COLUMNS.map((column) => column.cell(row))),
  ].map((cells) => cells.map(csvCell).join(","))
  return `\uFEFF${lines.join("\r\n")}\r\n`
}

/** The catalog as a JSON array of the exact list DTOs. */
export function catalogJson(rows: ProductListRow[]): string {
  return JSON.stringify(rows)
}
