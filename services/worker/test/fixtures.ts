/**
 * Test fixtures: RFC4180 CSV bytes, real-ZIP structures via yazl (photo
 * archives and XLSX workbooks), and corruption helpers for the EC-006/EC-008
 * failure classes.
 */
import { PassThrough, type Readable } from "node:stream"

import Yazl from "yazl"

/** Serialize rows to RFC4180 CSV (CRLF, quoted where needed). */
export function csvBytes(rows: string[][]): Buffer {
  const quote = (cell: string): string => {
    if (/[",\r\n]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`
    return cell
  }
  return Buffer.from(
    rows.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n",
    "utf8"
  )
}

export interface ZipEntrySpec {
  name: string
  data: Buffer | string
}

/** Build a real ZIP archive (yazl) from entry specs. */
export async function buildZip(entries: ZipEntrySpec[]): Promise<Buffer> {
  const zipfile = new Yazl.ZipFile()
  for (const entry of entries) {
    zipfile.addBuffer(
      Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data, "utf8"),
      entry.name
    )
  }
  const chunks: Buffer[] = []
  const passthrough = new PassThrough()
  passthrough.on("data", (chunk: Buffer) => chunks.push(chunk))
  const { promise: done, resolve } = Promise.withResolvers<void>()
  passthrough.on("end", resolve)
  zipfile.outputStream.pipe(passthrough)
  zipfile.end()
  await done
  return Buffer.concat(chunks)
}

/** Corrupt a ZIP by slicing bytes off the end (breaks the central directory). */
export function truncate(buffer: Buffer, keepBytes: number): Buffer {
  return buffer.subarray(0, Math.max(0, keepBytes))
}

/**
 * Rename an entry inside built ZIP bytes (local header + central directory)
 * without going through yazl, which refuses unsafe names. Hostile-name
 * fixtures need the real bytes a malicious archive would carry.
 */
export function patchZipEntryName(
  zip: Buffer,
  from: string,
  to: string
): Buffer {
  if (from.length !== to.length) {
    throw new Error("patchZipEntryName requires equal-length names")
  }
  const patched = zip.toString("latin1").replaceAll(from, to)
  return Buffer.from(patched, "latin1")
}

// ---------------------------------------------------------------- XLSX ----

export type XlsxCell = string | number | boolean

interface XlsxSheetSpec {
  name: string
  /** First row is the header. */
  rows: XlsxCell[][]
}

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

function cellRef(rowIndex0: number, colIndex0: number): string {
  let col = colIndex0 + 1
  let ref = ""
  while (col > 0) {
    const rem = (col - 1) % 26
    ref = COL_LETTERS[rem]! + ref
    col = Math.floor((col - 1) / 26)
  }
  return `${ref}${rowIndex0 + 1}`
}

function esc(xml: string): string {
  return xml
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/**
 * Build a minimal-but-honest XLSX workbook (zip of XML) with shared strings,
 * exactly the parts a reader consumes.
 */
export async function buildXlsx(sheets: XlsxSheetSpec[]): Promise<Buffer> {
  const shared: string[] = []
  const sharedIndex = (value: string): number => {
    const existing = shared.indexOf(value)
    if (existing !== -1) return existing
    shared.push(value)
    return shared.length - 1
  }

  const sheetXml = (rows: XlsxCell[][]): string => {
    const body = rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            const ref = cellRef(r, c)
            if (typeof cell === "string")
              return `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`
            if (typeof cell === "boolean")
              return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`
            return `<c r="${ref}"><v>${cell}</v></c>`
          })
          .join("")
        return `<row r="${r + 1}">${cells}</row>`
      })
      .join("")
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  }

  const sharedXml = (): string =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((s) => `<si><t>${esc(s)}</t></si>`)
      .join("")}</sst>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map(
      (sheet, i) =>
        `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join("")}</sheets></workbook>`

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join(
      ""
    )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`

  const entries: ZipEntrySpec[] = sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheetXml(sheet.rows),
  }))
  // sheetXml populated `shared` above, so the string table is built last.
  entries.push(
    { name: "[Content_Types].xml", data: TINY_CONTENT_TYPES },
    { name: "_rels/.rels", data: TINY_ROOT_RELS },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: relsXml },
    { name: "xl/sharedStrings.xml", data: sharedXml() }
  )
  return buildZip(entries)
}

const TINY_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`

const TINY_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

/** A tiny well-formed 1×1 PNG — hashing never decodes image bytes. */
export const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
)

export function bufferToStream(buffer: Buffer): Readable {
  const stream = new PassThrough()
  stream.end(buffer)
  return stream
}
