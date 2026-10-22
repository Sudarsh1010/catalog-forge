/**
 * Chaos flags on the Demo Mode stub provider — driven through the provider
 * PORT (the only injection point, spec: Testing Decisions). The stub stays
 * fully deterministic when chaos is off; every flag produces the exact
 * typed {@link ProviderError} fault class the Job machinery keys on
 * (EC-082): `rate_limited` with Retry-After, `server_error`, `invalid_json`.
 */
import { describe, expect, it } from "vitest"

import {
  ProviderError,
  createStubProvider,
  STUB_PROVIDER_ID,
  type EnrichInput,
} from "../src/provider/index.js"

const BASE_INPUT: EnrichInput = {
  product: {
    naturalKey: "sku:tp-100",
    naturalKeyHash: "a".repeat(64),
    identityKind: "code",
    title: "Gießkanne 5L",
    brand: "Brunner",
    category: "Garten > Bewässerung",
    description: "Robuste Gießkanne aus Stahlblech.",
    gtin: null,
  },
  attributes: {},
  photoCount: 0,
  messiness: 10,
  sourceRows: [1],
}

async function faultOf(run: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ProviderError) return error
    throw error
  }
  throw new Error("expected the call to fault")
}

describe("stub chaos flags", () => {
  it("stays deterministic and never faults when chaos is off", async () => {
    const a = createStubProvider()
    const b = createStubProvider()
    const first = await a.enrich(BASE_INPUT)
    const second = await b.enrich(BASE_INPUT)
    expect(first.value).toEqual(second.value)
    expect(first.usage.providerId).toBe(STUB_PROVIDER_ID)
  })

  it("fails every call with server_error at failureRate 1", async () => {
    const provider = createStubProvider({ failureRate: 1 })
    for (let i = 0; i < 3; i++) {
      const fault = await faultOf(() => provider.enrich(BASE_INPUT))
      expect(fault.fault.class).toBe("server_error")
      expect(fault.fault).toMatchObject({ class: "server_error", status: 500 })
    }
  })

  it("rate-limits only after N calls, honoring Retry-After, then recovers", async () => {
    const provider = createStubProvider({
      rateLimitAfter: 2,
      rateLimitFor: 2,
      retryAfterMs: 1234,
    })
    // Calls 1 and 2 succeed.
    await provider.enrich(BASE_INPUT)
    await provider.enrich(BASE_INPUT)
    // Calls 3 and 4 are throttled with the configured Retry-After.
    for (let i = 0; i < 2; i++) {
      const fault = await faultOf(() => provider.enrich(BASE_INPUT))
      expect(fault.fault).toEqual({
        class: "rate_limited",
        retryAfterMs: 1234,
      })
    }
    // The throttle window ended: call 5 succeeds again.
    await expect(provider.enrich(BASE_INPUT)).resolves.toBeDefined()
  })

  it("rate-limits indefinitely after N when no recovery window is set", async () => {
    const provider = createStubProvider({ rateLimitAfter: 1 })
    await provider.enrich(BASE_INPUT)
    for (let i = 0; i < 3; i++) {
      const fault = await faultOf(() =>
        provider.translate({
          locale: "de",
          fields: { title: "Gießkanne 5L" },
          brand: null,
          protectedTokens: [],
        })
      )
      expect(fault.fault.class).toBe("rate_limited")
    }
  })

  it("fails every call with invalid_json at invalidJsonRate 1", async () => {
    const provider = createStubProvider({ invalidJsonRate: 1 })
    const fault = await faultOf(() => provider.enrich(BASE_INPUT))
    expect(fault.fault).toEqual({
      class: "invalid_json",
      detail: expect.any(String),
    })
  })

  it("reproduces the same fault sequence under the same seed", async () => {
    const runSequence = (): Promise<
      Array<"ok" | "server_error" | "invalid_json">
    > => {
      const provider = createStubProvider({
        seed: 7,
        failureRate: 0.5,
        invalidJsonRate: 0.25,
      })
      return Promise.all(
        Array.from({ length: 24 }, () =>
          provider
            .enrich(BASE_INPUT)
            .then(() => "ok" as const)
            .catch((error: unknown) =>
              error instanceof ProviderError
                ? error.fault.class === "server_error"
                  ? ("server_error" as const)
                  : ("invalid_json" as const)
                : ("ok" as const)
            )
        )
      )
    }
    const first = await runSequence()
    const second = await runSequence()
    expect(first).toEqual(second)
    expect(first).toContain("server_error")
    expect(first).toContain("invalid_json")
    // A different seed drives a different roll stream (identical 24-roll
    // sequences across two fair-ish rolls would be a ~1e-11 coincidence).
    const other = await (async () => {
      const provider = createStubProvider({
        seed: 8,
        failureRate: 0.5,
        invalidJsonRate: 0.25,
      })
      return Promise.all(
        Array.from({ length: 24 }, () =>
          provider
            .enrich(BASE_INPUT)
            .then(() => "ok" as const)
            .catch((error: unknown) =>
              error instanceof ProviderError
                ? error.fault.class === "server_error"
                  ? ("server_error" as const)
                  : ("invalid_json" as const)
                : ("ok" as const)
            )
        )
      )
    })()
    expect(other).not.toEqual(first)
  })
})
