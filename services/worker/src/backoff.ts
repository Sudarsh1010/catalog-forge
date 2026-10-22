/**
 * Exponential backoff with jitter (EC-082: transport faults get a free-ish,
 * spaced retry; EC-083: jitter keeps thundering herds from re-syncing).
 * Pure policy — the Worker config supplies base, cap and the jitter source.
 */
export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs: number
  /** Upper bound for any single delay. */
  maxMs: number
  /** Uniform [0,1) randomness; production injects `Math.random`. */
  jitter: () => number
}

/**
 * Delay for the Nth attempt (1-based): `base * 2^(attempt-1)` plus
 * `jitter * base`, capped at `maxMs`.
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions
): number {
  const exponent = Math.max(1, Math.floor(attempt)) - 1
  const exponential = options.baseMs * 2 ** exponent
  const jittered = exponential + options.jitter() * options.baseMs
  return Math.min(options.maxMs, Math.round(jittered))
}
