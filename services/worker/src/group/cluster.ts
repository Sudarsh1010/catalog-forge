/**
 * Product-family clustering rules (EC-033/EC-060): when do two distinct
 * supplier codes belong under one Product?
 *
 * - `parent` — one code extends the other at a separator boundary
 *   (`TP-100` → `TP-100-R`): the parent link itself is the evidence.
 * - `sibling` — codes share a common prefix ending at a separator boundary
 *   (`TP-100-R` / `TP-100-G`): weak on its own, so it only merges inside a
 *   corroborating title bucket (equal normalized titles, EC-033's
 *   "corroboration" requirement). Disagreement → no merge (EC-060/EC-062).
 */

export const CODE_SEPARATORS: readonly string[] = ["-", "_", " "]

/** Would code `a` and code `b` cluster into one Product family? */
export function codeFamilyRelation(
  a: string,
  b: string
): "parent" | "sibling" | null {
  if (a === b) return null
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (long.startsWith(short)) {
    // `TP-100` vs `TP-1000` stays separate: no separator boundary (EC-062).
    return CODE_SEPARATORS.includes(long[short.length]!) ? "parent" : null
  }
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (i === 0) return null
  // The boundary holds when the shared prefix ends at a separator — either
  // each side continues with one (`TP-100|R` / `TP-100|G`) or the separator
  // itself is shared (`TP-100-|R` / `TP-100-|G`).
  const sharedBoundary = CODE_SEPARATORS.includes(a[i - 1]!)
  const boundaryA = CODE_SEPARATORS.includes(a[i]!)
  const boundaryB = CODE_SEPARATORS.includes(b[i]!)
  return sharedBoundary || (boundaryA && boundaryB) ? "sibling" : null
}

/**
 * The stable family base a Product's Natural Key is built from: the common
 * prefix of the family's codes at a separator boundary. A member that is
 * itself the common prefix wins (`TP-100` in {TP-100, TP-100-R}); sibling
 * families trim their common prefix (`{TP-100-R, TP-100-G}` → `TP-100`).
 * Deterministic in the member set, so re-runs derive the identical key.
 */
export function familyBase(codes: string[]): string {
  const sorted = [...new Set(codes)].sort()
  const shortest = sorted[0]!
  const longest = sorted[sorted.length - 1]!
  let i = 0
  while (
    i < shortest.length &&
    i < longest.length &&
    shortest[i] === longest[i]
  )
    i++
  if (i === shortest.length) return shortest // a member is the common prefix
  const lcp = shortest.slice(0, i)
  const cut = Math.max(
    lcp.lastIndexOf("-"),
    lcp.lastIndexOf("_"),
    lcp.lastIndexOf(" ")
  )
  if (cut > 0) return lcp.slice(0, cut)
  return shortest
}

/** Minimal union-find over row indexes. */
export class UnionFind {
  private parent: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(x: number): number {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root]!
    while (this.parent[x] !== root) {
      const next = this.parent[x]!
      this.parent[x] = root
      x = next
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
}
