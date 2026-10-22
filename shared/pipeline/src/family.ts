/**
 * Sheet-family identity for re-import key-diff (GLOSSARY: Missing-from-Source,
 * Fast Path). A merchant re-uploads a changed version of "their" sheet — the
 * lineage (family) that ties a re-import to the Import it updates. Identity is
 * the uploaded filename, normalized so `Supplier.csv` and `supplier.csv` are
 * one family; identical BYTES never reach this — content-hash dedupe targets
 * the same Import before a family matters.
 */
/** The normalized sheet-family key of an uploaded filename. */
export function familyKeyOf(filename: string): string {
  return filename.trim().toLowerCase()
}
