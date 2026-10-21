/**
 * Tunables for the worker's loops. Every interval is injectable so tests can
 * run the real loops against live Postgres without sleeping real 30s.
 */
export interface WorkerConfig {
  /** Stable identity for leases; defaults to a per-process random id. */
  workerId: string
  /** How often the claim loop looks for work. */
  claimIntervalMs: number
  /** How often heartbeats renew this worker's live leases. */
  heartbeatIntervalMs: number
  /** How often the safety-net Sweeper runs. */
  sweepIntervalMs: number
  /** Lease time-to-live, renewed by heartbeats. */
  leaseTtlMs: number
  /** Attempts before a Job terminates as Failed (ADR-0003). */
  maxAttempts: number
  /** Jobs claimed per claim tick. */
  batchSize: number
  /** Injectable clock (ms epoch). Defaults to `Date.now`. */
  now: () => number
}

export const DEFAULT_CONFIG: Omit<WorkerConfig, "workerId"> = {
  claimIntervalMs: 250,
  heartbeatIntervalMs: 10_000,
  sweepIntervalMs: 30_000,
  leaseTtlMs: 30_000,
  maxAttempts: 5,
  batchSize: 5,
  now: () => Date.now(),
}

export function resolveConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return {
    ...DEFAULT_CONFIG,
    workerId:
      overrides?.workerId ??
      `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    ...stripUndefined(overrides),
  }
}

function stripUndefined<T extends object>(value?: T): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>
}
