/**
 * The provider REGISTRY in the worker's runtime shape (spec: per-provider
 * concurrency semaphores; routing tiers assigned from the Messiness Score).
 * A tier resolves to one provider entry; all its calls run under that
 * entry's semaphore, so no provider is ever hammered past its limit (EC-083)
 * — across all Imports in this process.
 */
import type { Provider, RoutingTier } from "./port"

/** One provider's registration: identity, cap, and the tiers it serves. */
export interface ProviderEntry {
  provider: Provider
  /** Max concurrent in-flight calls through this provider. */
  concurrency: number
  tiers: readonly RoutingTier[]
}

export interface ProviderRegistry {
  /** Run one call against the provider serving `tier`, under its semaphore. */
  run<T>(
    tier: RoutingTier,
    operation: (provider: Provider) => Promise<T>
  ): Promise<T>
  /**
   * Which provider serves `tier` — the planner stamps Jobs with it at plan
   * time, so the Pause claim gate can hold exactly those Jobs (spec:
   * "routing tiers are assigned to Jobs at plan time"). Throws for an
   * unregistered tier, mirroring `run`.
   */
  providerIdForTier(tier: RoutingTier): string
}

/**
 * Strict hand-off semaphore: a released permit goes to the oldest waiter or,
 * when none wait, back to new arrivals — a woken waiter can never overshoot
 * the cap, and new callers can never barge past queued ones.
 */
class Semaphore {
  readonly #limit: number
  #active = 0
  readonly #waiters: Array<() => void> = []

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      const { promise, resolve } = Promise.withResolvers<void>()
      this.#waiters.push(resolve)
      await promise // the permit was handed to us; #active stays at the cap
    } else {
      this.#active++
    }
    try {
      return await operation()
    } finally {
      const wake = this.#waiters.shift()
      if (wake) wake()
      else this.#active--
    }
  }
}

export function createProviderRegistry(
  entries: ProviderEntry[]
): ProviderRegistry {
  const byTier = new Map<
    RoutingTier,
    { provider: Provider; semaphore: Semaphore }
  >()
  for (const entry of entries) {
    const semaphore = new Semaphore(entry.concurrency)
    for (const tier of entry.tiers) {
      if (!byTier.has(tier))
        byTier.set(tier, { provider: entry.provider, semaphore })
    }
  }
  return {
    providerIdForTier(tier: RoutingTier): string {
      const resolved = byTier.get(tier)
      if (!resolved) {
        throw new Error(
          `provider registry: no provider registered for tier "${tier}"`
        )
      }
      return resolved.provider.id
    },
    async run<T>(
      tier: RoutingTier,
      operation: (provider: Provider) => Promise<T>
    ): Promise<T> {
      const resolved = byTier.get(tier)
      if (!resolved) {
        throw new Error(
          `provider registry: no provider registered for tier "${tier}"`
        )
      }
      return resolved.semaphore.run(() => operation(resolved.provider))
    },
  }
}
