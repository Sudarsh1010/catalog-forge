/**
 * Streaming XLSX intake (EC-001/EC-008): the workbook is a ZIP of XML; we
 * SAX-parse worksheet XML incrementally — a 1,048,576-row "dimension bloat"
 * sheet costs no more memory than a 10-row one. Shared strings are loaded
 * once (that is how the format works); worksheet rows are never buffered
 * whole.
 *
 * Sheet selection follows the spec default (EC-012): the largest non-empty
 * data sheet, worksheets in workbook order.
 */
import { type Readable } from "node:stream"

import yauzl from "yauzl"
import { SaxesParser } from "saxes"

import type { SheetCell } from "@workspace/db/schema"
import type { Limits } from "@workspace/pipeline"

import { IntakeError } from "./errors"
import type { SheetRowEvent } from "./csv"

const WORKSHEET_PATTERN = /^xl\/worksheets\/sheet(\d+)\.xml$/

function corruptWorkbook(hint?: string): IntakeError {
  return new IntakeError(
    `The Excel workbook is corrupt or unreadable${hint ? ` — ${hint}` : ""}. Re-export it as .xlsx and upload again.`,
    { ec: "EC-006" }
  )
}

export interface ZipHandle {
  zipfile: yauzl.ZipFile
  entries: yauzl.Entry[]
  /**
   * Rejects with an IntakeError when yauzl hits a structural or validation
   * error mid-read (yauzl itself rejects unsafe entry names while iterating,
   * i.e. after openZip has resolved). Callers race their work against this.
   */
  failure: Promise<never>
}

export interface ZipOpenWording {
  /** Noun for messages, e.g. "Excel workbook (.xlsx)" or "photo archive". */
  what: string
  /** Extra hint when the bytes are not a ZIP at all. */
  notZipHint?: string
}

function zipReadError(error: Error, wording: ZipOpenWording): IntakeError {
  if (/invalid relative path/i.test(error.message)) {
    return new IntakeError(
      `The ${wording.what} contains an entry with an unsafe relative path — path traversal is not allowed. (${error.message})`,
      { ec: "EC-006" }
    )
  }
  return new IntakeError(
    `The ${wording.what} is truncated or corrupt while reading. Re-export or re-upload the file. (${error.message})`,
    { ec: "EC-006" }
  )
}

export function openZip(
  filePath: string,
  wording: ZipOpenWording
): Promise<ZipHandle> {
  const { promise, resolve, reject } = Promise.withResolvers<ZipHandle>()
  const failure = Promise.withResolvers<never>()
  yauzl.open(
    filePath,
    { lazyEntries: true, autoClose: false, validateEntrySizes: true },
    (error, zipfile) => {
      if (error || !zipfile) {
        // Not a ZIP at all: the classic "HTML error page saved as .xlsx".
        reject(
          new IntakeError(
            `The ${wording.what} is not a readable ZIP file — it may be truncated, corrupt, or the wrong format${wording.notZipHint ?? ""}. Re-export or re-upload the file.`,
            { ec: "EC-006" }
          )
        )
        return
      }
      const entries: yauzl.Entry[] = []
      let resolved = false
      zipfile.on("error", (readError: Error) => {
        zipfile.close()
        const intakeError = zipReadError(readError, wording)
        if (resolved) {
          // Post-resolve read errors reach callers through `failure`.
          failure.reject(intakeError)
        } else {
          reject(intakeError)
        }
      })
      zipfile.on("entry", (entry: yauzl.Entry) => {
        entries.push(entry)
        zipfile.readEntry()
      })
      zipfile.on("end", () => {
        resolved = true
        resolve({ zipfile, entries, failure: failure.promise })
      })
      zipfile.readEntry()
    }
  )
  return promise
}

export function closeZip(handle: ZipHandle): void {
  handle.zipfile.close()
}

export function openEntryStream(
  handle: ZipHandle,
  entry: yauzl.Entry
): Promise<Readable> {
  const { promise, resolve, reject } = Promise.withResolvers<Readable>()
  handle.zipfile.openReadStream(entry, (error, stream) => {
    if (error || !stream) {
      reject(corruptWorkbook(`entry "${entry.fileName}" could not be read`))
      return
    }
    resolve(stream)
  })
  return promise
}

// ------------------------------------------------------------- SAX layer --

interface CellValue {
  column: number
  value: SheetCell
}

/** Column letters ("A"→0, "Z"→25, "AA"→26); base-26 with no zero digit. */
function columnIndex(ref: string | undefined): number {
  if (!ref) return -1
  let column = 0
  let sawLetter = false
  for (const char of ref) {
    if (char < "A" || char > "Z") break
    sawLetter = true
    column = column * 26 + (char.charCodeAt(0) - 64)
  }
  return sawLetter ? column - 1 : -1
}

interface WorksheetParserEvents {
  onRow(cells: SheetCell[]): void
}

interface ParseOutcome {
  finished: Promise<void>
}

/**
 * SAX-parse one worksheet XML stream, calling `onRow` for each trimmed
 * non-empty row. Cell values keep their stored scalar type: shared strings
 * resolve to text, inline strings stay text, numbers stay numbers,
 * booleans become booleans.
 */
function parseWorksheet(
  stream: Readable,
  sharedStrings: string[],
  events: WorksheetParserEvents
): ParseOutcome {
  const parser = new SaxesParser({})

  let rowBuffer: SheetCell[] = []
  let rowHasContent = false
  let nextColumn = 0
  let cell: {
    column: number
    type: string
    text: string
    inline: boolean
  } | null = null
  let collectingValue = false
  let inlineText = ""
  let parseError: Error | undefined

  const resolveCell = (): CellValue | null => {
    if (!cell) return null
    const raw = cell.text.trim()
    let value: SheetCell
    switch (cell.type) {
      case "s": {
        const index = Number(raw)
        value = Number.isInteger(index) ? (sharedStrings[index] ?? "") : ""
        break
      }
      case "b":
        value = raw === "1"
        break
      case "e":
        // Formula error values (#N/A, #DIV/0!) stay as the literal text —
        // raw truth, flagged later by the clean Stage.
        value = cell.text
        break
      default: {
        // "" (formula string result) and inline strings arrive here too.
        if (raw === "") {
          value = null
        } else {
          const numeric = Number(raw)
          value = Number.isFinite(numeric) ? numeric : cell.text
        }
      }
    }
    return { column: cell.column, value }
  }

  const appendCell = (resolved: CellValue | null): void => {
    if (!resolved) return
    const { column, value } = resolved
    if (column >= 0) {
      while (rowBuffer.length <= column) rowBuffer.push(null)
      rowBuffer[column] = value
    } else {
      rowBuffer.push(value)
    }
    if (value !== null && value !== "") rowHasContent = true
  }

  parser.on("error", (error: Error) => {
    parseError = error
  })

  parser.on("opentag", (node) => {
    const attributes = node.attributes as Record<string, string>
    if (node.name === "row") {
      rowBuffer = []
      rowHasContent = false
      nextColumn = 0
    } else if (node.name === "c") {
      const refColumn = columnIndex(attributes.r)
      const column = refColumn >= 0 ? refColumn : nextColumn
      nextColumn = column + 1
      cell = {
        column,
        type: attributes.t ?? "",
        text: "",
        inline: attributes.t === "inlineStr",
      }
      inlineText = ""
    } else if (node.name === "v") {
      collectingValue = true
    } else if (node.name === "t") {
      // <t> appears inside inline strings (<is><t>) in worksheets.
      collectingValue = cell?.inline === true
    }
  })

  parser.on("text", (text: string) => {
    if (!collectingValue) return
    if (cell?.inline) inlineText += text
    else if (cell) cell.text += text
  })

  parser.on("closetag", (node) => {
    if (node.name === "v" || node.name === "t") {
      collectingValue = false
    } else if (node.name === "c") {
      if (cell && !cell.inline) appendCell(resolveCell())
      cell = null
    } else if (node.name === "is") {
      if (cell?.inline) appendCell({ column: cell.column, value: inlineText })
    } else if (node.name === "row") {
      if (rowHasContent) {
        const trimmed = [...rowBuffer]
        while (
          trimmed.length > 0 &&
          (trimmed[trimmed.length - 1] ?? null) === null
        )
          trimmed.pop()
        events.onRow(trimmed)
      }
      rowBuffer = []
    }
  })

  const finished = (async () => {
    stream.setEncoding("utf8")
    try {
      for await (const chunk of stream) {
        parser.write(chunk as string)
        if (parseError) return
      }
      if (!parseError) parser.close()
    } catch (error) {
      // Low-level read failure (damaged deflate stream, storage hiccup).
      if (error instanceof IntakeError) throw error
      throw corruptWorkbook("worksheet data could not be read")
    }
    if (parseError) {
      throw new IntakeError(
        "The Excel workbook contains malformed XML — re-export it and upload again.",
        { ec: "EC-006" }
      )
    }
  })()

  return { finished }
}

async function loadSharedStrings(
  handle: ZipHandle,
  entry: yauzl.Entry
): Promise<string[]> {
  const strings: string[] = []
  const parser = new SaxesParser({})
  let current = ""
  let inItem = false
  let inPhonetic = false
  let textDepth = 0
  let parseError: Error | undefined

  parser.on("error", (error: Error) => {
    parseError = error
  })
  parser.on("opentag", (node) => {
    if (node.name === "si") {
      inItem = true
      current = ""
    } else if (node.name === "rPh") {
      inPhonetic = true
    } else if (node.name === "t") {
      textDepth++
    }
  })
  parser.on("text", (text: string) => {
    if (inItem && !inPhonetic && textDepth > 0) current += text
  })
  parser.on("closetag", (node) => {
    if (node.name === "si") {
      strings.push(current)
      inItem = false
    } else if (node.name === "rPh") {
      inPhonetic = false
    } else if (node.name === "t") {
      textDepth--
    }
  })

  const stream = await openEntryStream(handle, entry)
  stream.setEncoding("utf8")
  try {
    for await (const chunk of stream) {
      parser.write(chunk as string)
      if (parseError) break
    }
    if (!parseError) parser.close()
  } catch (error) {
    if (error instanceof IntakeError) throw error
    throw corruptWorkbook("shared strings could not be read")
  }
  if (parseError) throw corruptWorkbook("shared strings are malformed")
  return strings
}

// ------------------------------------------------------------ public API --

interface WorksheetInfo {
  entry: yauzl.Entry
  number: number
}

/**
 * Stream-parse an XLSX file from disk into sheet-row events (header first).
 * Picks the largest non-empty worksheet; the row cap applies during the
 * counting pass so a bloated workbook fails fast (EC-008).
 */
export async function* parseXlsxFile(
  filePath: string,
  limits: Limits
): AsyncGenerator<SheetRowEvent, void, void> {
  const handle = await openZip(filePath, {
    what: "Excel workbook (.xlsx)",
    notZipHint: " (for example an HTML page renamed to .xlsx)",
  })
  try {
    const worksheets: WorksheetInfo[] = []
    let sharedStringsEntry: yauzl.Entry | undefined
    for (const entry of handle.entries) {
      const match = WORKSHEET_PATTERN.exec(entry.fileName)
      if (match) {
        worksheets.push({ entry, number: Number(match[1]) })
      } else if (entry.fileName === "xl/sharedStrings.xml") {
        sharedStringsEntry = entry
      }
    }
    worksheets.sort((a, b) => a.number - b.number)
    if (worksheets.length === 0) {
      throw new IntakeError(
        "The file is a ZIP but not an Excel workbook — no worksheets found. Check the .xlsx was exported, not renamed.",
        { ec: "EC-006" }
      )
    }

    const sharedStrings = sharedStringsEntry
      ? await loadSharedStrings(handle, sharedStringsEntry)
      : []

    // Pass 1: count non-empty rows per worksheet (streams, never lands).
    const counts: number[] = []
    for (const worksheet of worksheets) {
      let count = 0
      const stream = await openEntryStream(handle, worksheet.entry)
      const { finished } = parseWorksheet(stream, sharedStrings, {
        onRow: () => {
          count++
          if (count > limits.maxSheetRows) {
            throw new IntakeError(
              `The sheet has more than ${limits.maxSheetRows.toLocaleString("en-US")} rows — split it into smaller sheets or contact support to raise the limit.`,
              { ec: "EC-008" }
            )
          }
        },
      })
      await Promise.race([finished, handle.failure])
      counts.push(count)
    }

    let winner = 0
    for (const [index, count] of counts.entries()) {
      if (count > counts[winner]!) winner = index
    }

    // Pass 2: stream the winning worksheet out through a tiny async queue.
    const queue: SheetRowEvent[] = []
    let drained = false
    let failure: unknown
    let notify: (() => void) | null = null
    const signal = (): void => {
      const wake = notify
      notify = null
      wake?.()
    }

    const stream = await openEntryStream(handle, worksheets[winner]!.entry)
    let headerSeen = false
    let rowCount = 0
    const { finished } = parseWorksheet(stream, sharedStrings, {
      onRow: (cells) => {
        if (!headerSeen) {
          headerSeen = true
          queue.push({
            kind: "header",
            cells: cells.map((cell) => String(cell ?? "")),
          })
        } else {
          rowCount++
          queue.push({ kind: "row", cells })
        }
        signal()
      },
    })
    void finished.then(
      () => {
        drained = true
        signal()
      },
      (error: unknown) => {
        failure = error
        drained = true
        signal()
      }
    )

    for (;;) {
      while (queue.length > 0) yield queue.shift()!
      if (drained) break
      const wake = Promise.withResolvers<void>()
      notify = wake.resolve
      await Promise.race([wake.promise, handle.failure])
    }
    if (failure !== undefined) throw failure
    await finished.catch(() => {})

    if (!headerSeen) {
      throw new IntakeError(
        "The Excel workbook has no readable header row — the largest sheet appears to be empty.",
        { ec: "EC-011" }
      )
    }
    if (rowCount === 0) {
      throw new IntakeError(
        "The sheet has no data rows — only a header row was found. Check the export includes your data.",
        { ec: "EC-011" }
      )
    }
  } finally {
    closeZip(handle)
  }
}
