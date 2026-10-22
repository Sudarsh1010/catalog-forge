/**
 * Exponential backoff with jitter (EC-082/EC-083) — the pure policy the
 * Worker applies when requeueing Jobs after 5xx/timeout/invalid-JSON
 * faults. Jitter is injectable so tests pin it; production uses Math.random.
 */
import { describe, expect, it } from "vitest"

import { backoffDelayMs } from "../src/backoff.js"

const NO_JITTER = { baseMs: 1_000, maxMs: 60_000, jitter: () => 0 }
const HALF_JITTER = { baseMs: 1_000, maxMs: 60_000, jitter: () => 0.5 }

describe("backoffDelayMs", () => {
  it("doubles per attempt from the base", () => {
    expect(backoffDelayMs(1, NO_JITTER)).toBe(1_000)
    expect(backoffDelayMs(2, NO_JITTER)).toBe(2_000)
    expect(backoffDelayMs(3, NO_JITTER)).toBe(4_000)
    expect(backoffDelayMs(4, NO_JITTER)).toBe(8_000)
  })

  it("caps at maxMs", () => {
    const capped = { ...NO_JITTER, maxMs: 5_000 }
    expect(backoffDelayMs(4, capped)).toBe(5_000)
    expect(backoffDelayMs(10, capped)).toBe(5_000)
  })

  it("adds jitter proportional to the base, still capped", () => {
    expect(backoffDelayMs(1, HALF_JITTER)).toBe(1_500)
    expect(backoffDelayMs(3, HALF_JITTER)).toBe(4_500)
    const tight = { ...HALF_JITTER, maxMs: 4_200 }
    expect(backoffDelayMs(3, tight)).toBe(4_200)
  })

  it("treats attempts below 1 as the first attempt", () => {
    expect(backoffDelayMs(0, NO_JITTER)).toBe(1_000)
  })
})
