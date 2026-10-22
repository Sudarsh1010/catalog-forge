/**
 * Streaming CSV intake (EC-004): BOM/encoding guard (EC-002), delimiter
 * sniffing (EC-003), RFC4180 records (quoted commas, escaped quotes,
 * embedded newlines) — never whole-file-in-memory (EC-008).
 *
 * Yields the header row first, then one row event per data row. Cells stay
 * exactly as sent: strings, nothing cleaned.
 */
import { once } from "node:events"
import { type Readable } from "node:stream"

import { parse } from "csv-parse"

import type { SheetCell } from "@workspace/db/schema"

import { IntakeError } from "./errors"

export type SheetRowEvent =
  | { kind: "header"; cells: string[] }
  | { kind: "row"; cells: SheetCell[] }

const SNIFF_BYTES = 64 * 1024
const DELIMITER_CANDIDATES = [",", ";", "\t", "|"] as const

const NOT_UTF8 = (why: string): IntakeError =>
  new IntakeError(
    `The sheet is ${why}. Re-export it as UTF-8 CSV or XLSX and upload again — decoding it "best effort" would silently corrupt your data.`,
    { ec: "EC-002" }
  )

/**
 * Decode the byte stream to UTF-8 text, fatally: a UTF-16 BOM or invalid
 * UTF-8 fails the sheet with a re-export hint instead of mojibake (EC-002).
 * The UTF-8 BOM is stripped.
 */
async function* decodeUtf8Strict(
  source: Readable
): AsyncGenerator<string, void, void> {
  let prefix: Buffer = Buffer.alloc(0)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bomChecked = false
  for await (const chunk of source) {
    let buffer = Buffer.concat([prefix, chunk as Buffer])
    if (!bomChecked) {
      if (buffer.length < 2 && !source.readableEnded) continue
      const isUtf16Le = buffer[0] === 0xff && buffer[1] === 0xfe
      const isUtf16Be = buffer[0] === 0xfe && buffer[1] === 0xff
      if (isUtf16Le || isUtf16Be) throw NOT_UTF8("UTF-16 encoded")
      if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        buffer = buffer.subarray(3)
      }
      bomChecked = true
    }
    try {
      const text = decoder.decode(buffer, { stream: true })
      if (text) yield text
    } catch {
      throw NOT_UTF8("not valid UTF-8 (Windows-1252/Latin-1?)")
    }
    prefix = Buffer.alloc(0)
  }
  try {
    const tail = decoder.decode()
    if (tail) yield tail
  } catch {
    throw NOT_UTF8("not valid UTF-8 (Windows-1252/Latin-1?)")
  }
}

/**
 * Pick the delimiter that appears most often outside quotes in the first
 * 64 KB (EC-003: German sheets use `;`, tabs and pipes happen). Falls back
 * to `,`.
 */
function sniffDelimiter(sample: string): string {
  const counts = new Map<string, number>(
    DELIMITER_CANDIDATES.map((d) => [d, 0])
  )
  let inQuotes = false
  for (const char of sample) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (inQuotes) continue
    const count = counts.get(char)
    if (count !== undefined) counts.set(char, count + 1)
  }
  let best: string = ","
  let bestCount = 0
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

/** Ragged rows are kept as-is (EC-005: the clean Stage flags them); trailing
 * empty cells from phantom trailing delimiters (EC-004) are trimmed. */
function trimTrailingEmpties(cells: string[]): string[] {
  const copy = [...cells]
  while (copy.length > 0 && (copy[copy.length - 1] ?? "") === "") copy.pop()
  return copy
}

async function* parseInner(
  source: Readable
): AsyncGenerator<SheetRowEvent, void, void> {
  // Text layer first: BOM handling and fatal UTF-8 (EC-002) — sampling and
  // parsing both consume this stream.
  const text = decodeUtf8Strict(source)

  // Read the head for delimiter sniffing, keeping the rest of the stream.
  let sample = ""
  let seen = 0
  for (;;) {
    const next = await text.next()
    if (next.done) break
    sample += next.value
    seen += next.value.length
    if (seen >= SNIFF_BYTES) break
  }

  const parser = parse({
    delimiter: sniffDelimiter(sample),
    relax_column_count: true,
    skip_empty_lines: true,
  })

  // Pump everything (sample first, then the rest) through the parser.
  // A pump failure is stored, not destroyed into the parser: transient
  // (storage/network) errors must reach the lease machinery for retry, and
  // encoding IntakeErrors must not be re-labeled as CSV parse errors.
  let pumpError: unknown
  const pumping = (async () => {
    try {
      parser.write(sample)
      for (;;) {
        const next = await text.next()
        if (next.done) break
        if (!parser.write(next.value)) await once(parser, "drain")
      }
    } catch (error) {
      pumpError = error
    }
    parser.end()
  })()

  let headerSeen = false
  try {
    for await (const record of parser) {
      const cells = trimTrailingEmpties(record as string[])
      if (!headerSeen) {
        headerSeen = true
        if (cells.length > 0) yield { kind: "header", cells }
        continue
      }
      if (cells.length > 0) yield { kind: "row", cells }
    }
  } catch (error) {
    if (error instanceof IntakeError) throw error
    throw new IntakeError(
      "The sheet could not be parsed as CSV — check for unterminated quotes or a corrupt export and try again.",
      { ec: "EC-004" }
    )
  }
  await pumping
  if (pumpError !== undefined) throw pumpError
}

/**
 * Parse a CSV byte stream into sheet-row events. The stream is consumed
 * exactly once and destroyed on early exit; parsing is incremental from the
 * first byte — no buffering of the whole file (EC-008).
 */
export async function* parseCsvStream(
  source: Readable
): AsyncGenerator<SheetRowEvent, void, void> {
  try {
    yield* parseInner(source)
  } catch (error) {
    if (error instanceof IntakeError) throw error
    throw new IntakeError(
      "The sheet could not be parsed as CSV — check for unterminated quotes or a corrupt export and try again.",
      { ec: "EC-004" }
    )
  } finally {
    source.destroy()
  }
}
