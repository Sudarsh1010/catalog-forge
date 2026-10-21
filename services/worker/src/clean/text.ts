/**
 * Text normalization for the clean Stage: mojibake repair (EC-002),
 * invisible-character stripping (EC-057), and the NFC match key with
 * AutoCorrect-artifact folding (EC-020/EC-053). Display values keep the
 * supplier's characters; keys are for matching only.
 */

/**
 * Characters whose code points are the tell-tale lead/continuation bytes of
 * UTF-8 misdecoded as Windows-1252/Latin-1 (`KÃ¤se`, `cafÃ©`).
 */
const MOJIBAKE_HINT =
  /[\u00c2\u00c3\u00c4\u00c5\u00cb\u00ce\u00cf\u00e2\u00e4\u00e5\u00ef][\u0080-\u00ff]/g

export interface EncodingRepair {
  value: string
  repaired: boolean
  /** False when mojibake was detected but cannot be repaired safely. */
  recoverable: boolean
}

/**
 * Repair UTF-8-read-as-Latin-1 mojibake by reversing the misdecode. A repair
 * is applied only when it strictly reduces mojibake markers and introduces
 * neither replacement characters nor C1 controls — anything else is flagged
 * unrecoverable instead of guessed at (EC-002: never lossy best-effort).
 */
export function repairEncoding(text: string): EncodingRepair {
  if (text.includes("\ufffd")) {
    return { value: text, repaired: false, recoverable: false }
  }
  MOJIBAKE_HINT.lastIndex = 0
  if (!MOJIBAKE_HINT.test(text)) {
    return { value: text, repaired: false, recoverable: true }
  }
  const repaired = Buffer.from(text, "latin1").toString("utf8")
  const improves =
    !repaired.includes("\ufffd") &&
    !/[\u0080-\u009f]/.test(repaired) &&
    countHints(repaired) < countHints(text)
  if (!improves) {
    return { value: text, repaired: false, recoverable: false }
  }
  return { value: repaired, repaired: true, recoverable: true }
}

function countHints(text: string): number {
  MOJIBAKE_HINT.lastIndex = 0
  let count = 0
  while (MOJIBAKE_HINT.exec(text) !== null) count++
  return count
}

/**
 * Control/invisible characters that break string equality and search
 * (EC-057): zero-widths, soft hyphen, bidi marks, C0/C1 controls. NBSP is
 * deliberately kept in display values (French typography); the match key
 * folds it away.
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g

export function stripInvisible(text: string): {
  value: string
  changed: boolean
} {
  const value = text.replace(INVISIBLE_CHARS, "")
  return { value, changed: value !== text }
}

/**
 * The NFC matching key (EC-053): case-folded, AutoCorrect artifacts folded
 * to their ASCII base forms (EC-020), NBSP/whitespace collapsed. Display
 * originals are never touched.
 */
const KEY_FOLDS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201a\u201b\u2032\u00b4`]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2012\u2013\u2014\u2015]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
  [/\u00bd/g, "1/2"],
  [/\u00bc/g, "1/4"],
  [/\u00be/g, "3/4"],
  [/\u2153/g, "1/3"],
]

export function matchKey(display: string): string {
  let key = display.normalize("NFC").toLowerCase()
  for (const [pattern, replacement] of KEY_FOLDS)
    key = key.replace(pattern, replacement)
  return key.replaceAll(/\s+/g, " ").trim()
}

/** True when a cell is blank after whitespace/NBSP trimming (missing value). */
export function isBlank(text: string): boolean {
  return text.replaceAll(/[\s\u00a0]/g, "").length === 0
}
