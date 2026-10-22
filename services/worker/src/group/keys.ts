/**
 * Identity keys for the group Barrier Stage (EC-034/EC-035/EC-036).
 *
 * Builds on the clean Stage's match-key helpers (NFC, case-fold, quote/dash
 * folds, whitespace collapse) and adds the code-level folds dedup needs:
 * hyphen lookalikes (the non-breaking hyphen U+2011 family), leftover
 * invisibles (soft hyphen, zero-widths), and GTIN zero-padding.
 */
import { createHash } from "node:crypto"

import { matchKey } from "../clean/text"

/** Hyphen lookalikes that must fold to ASCII `-` before hashing (EC-034). */
const HYPHEN_LOOKALIKES = /[\u02d7\u2010\u2011\u2043]/g

/**
 * Invisibles a display value could still carry (EC-034): soft hyphen,
 * zero-widths and directional marks. NBSP is already folded by the clean
 * match key.
 */
const LEFTOVER_INVISIBLES = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g

/**
 * The canonical identity key of a code or title: NFC, case-folded (EC-035 —
 * the dedup key is case-insensitive; display values keep the supplier's
 * casing), invisible-folded and hyphen-folded (EC-034). Whitespace adjacent
 * to a hyphen collapses into it, so `ABC - 001` and `ABC-001` share a key.
 */
export function identityKey(display: string): string {
  const folded = matchKey(display)
    .replace(HYPHEN_LOOKALIKES, "-")
    .replace(LEFTOVER_INVISIBLES, "")
  return folded.replace(/\s*-\s*/g, "-").trim()
}

/**
 * GTIN family normalization (EC-036): digits only, zero-padded to GTIN-14 so
 * UPC-A (12), EAN-13/8 and GTIN-14 forms of the same item share one key.
 * Check-digit validation is deliberately not applied here — corruption is
 * the clean Stage's concern (EC-014); grouping only needs a stable key.
 */
export function normalizeGtin(display: string): string | null {
  const digits = display.replace(/\D+/g, "")
  if (digits.length === 0) return null
  if (![8, 12, 13, 14].includes(digits.length)) return digits
  return digits.padStart(14, "0")
}

/** sha256 of a canonical key — the stored dedup identity (EC-068). */
export function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex")
}
