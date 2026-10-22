/**
 * OpenAI provider unit tests — the real provider behind the Port, driven
 * against an injected fake OpenAI endpoint (createOpenAI's `fetch` seam).
 * No database: fault mapping (EC-082), claim-pointer enforcement (EC-075),
 * the Confidence gate (EC-099), translate round-trip validation
 * (EC-089/EC-090) and real per-call pricing are the port's pure contract.
 */
import { describe, expect, it } from "vitest"

import {
  OPENAI_FAST_MODEL,
  OPENAI_STRONG_MODEL,
  ProviderError,
  costMicrosFor,
  createOpenAIProvider,
  createProviderRegistry,
  openAIProviderEntries,
} from "../src/index.js"
import type { EnrichInput } from "../src/provider/port.js"

// --------------------------------------------------------- fake endpoint --

interface RecordedRequest {
  url: string
  body: {
    model?: string
    messages?: Array<{ role: string; content: string }>
    [key: string]: unknown
  }
}

interface FakeEndpoint {
  fetch: typeof globalThis.fetch
  requests: RecordedRequest[]
}

/**
 * An OpenAI `/chat/completions` fake: records requests, answers from the
 * script. `respond` returns the Response — status/headers/content all
 * scripted per test.
 */
function fakeEndpoint(
  respond: (request: RecordedRequest) => Response | Promise<Response>
): FakeEndpoint {
  const requests: RecordedRequest[] = []
  const fetch = (async (input, init) => {
    const request: RecordedRequest = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    }
    requests.push(request)
    return respond(request)
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

/** A fetch that never answers — rejects only when the abort signal fires. */
function hangingEndpoint(): typeof globalThis.fetch {
  return ((_input, init) => {
    const { promise, reject } = Promise.withResolvers<Response>()
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "TimeoutError"))
    })
    return promise
  }) as typeof globalThis.fetch
}

/** A minimal OpenAI chat-completion envelope carrying `content`. */
function chatCompletion(
  content: string,
  usage?: Record<string, number>
): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model: OPENAI_FAST_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: usage ?? { prompt_tokens: 120, completion_tokens: 80 },
  })
}

function completionContent(value: unknown): Response {
  return chatCompletion(JSON.stringify(value))
}

function errorResponse(
  status: number,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify({ error: { message: "boom" } }), {
    status,
    headers,
  })
}

// ------------------------------------------------------------- fixtures --

const HASH = "3f7a1c".padEnd(64, "0")

const enrichInput: EnrichInput = {
  product: {
    naturalKey: "sku:tp-100",
    naturalKeyHash: HASH,
    identityKind: "code",
    title: "Gießkanne 5L",
    brand: "Brunner",
    category: null,
    description: "Robuste Gießkanne aus Stahlblech.",
    gtin: null,
  },
  attributes: { Farbe: "rot" },
  photoCount: 2,
  messiness: 22,
  sourceRows: [1, 2],
  sourceRowValues: [
    {
      rowIndex: 1,
      values: { SKU: "TP-100-R", Title: "Gießkanne 5L", Farbe: "rot" },
    },
    {
      rowIndex: 2,
      values: { SKU: "TP-100-G", Title: "Gießkanne 5L", Farbe: "grün" },
    },
  ],
}

function provider(fetch?: typeof globalThis.fetch) {
  return createOpenAIProvider({
    apiKey: "test-key",
    model: OPENAI_FAST_MODEL,
    ...(fetch !== undefined ? { fetch } : {}),
  })
}

/** Awaits a call expected to fail, returning the typed fault. */
async function faultOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (caught) {
    return caught as ProviderError
  }
  throw new Error("expected the call to fail with a ProviderError")
}

const validEnrichOutput = {
  title: "Brunner Gießkanne 5L",
  description: "Robuste Gießkanne aus Stahlblech.",
  category: "",
  tags: ["gießkanne", "stahl"],
  attributes: [
    { name: "Farbe", value: "rot" },
    { name: "", value: "dropped" },
  ],
  confidence: {
    title: 95,
    description: 92,
    category: 30,
    tags: 85,
    attributes: 90,
  },
  status: "ready" as const,
  claims: [
    { text: "aus Stahlblech", sourceRowIndex: 1, sourceColumn: "Title" },
    { text: "hallucinated", sourceRowIndex: 9, sourceColumn: "Title" },
    { text: "wrong column", sourceRowIndex: 1, sourceColumn: "Nope" },
  ],
  reviewReasons: ["category: missing from source."],
}

const translateInput = {
  locale: "de" as const,
  brand: "Brunner",
  protectedTokens: ["TP-100"],
  fields: {
    title: "Watering can 5 l",
    description: "Robust steel watering can, model TP-100.",
    category: "Garden > Watering",
  },
}

// --------------------------------------------------------------- enrich --

describe("openai enrich", () => {
  it("calls the tier's model and maps the output into the port shape", async () => {
    const fake = fakeEndpoint(() => completionContent(validEnrichOutput))
    const { value, usage } = await provider(fake.fetch).enrich(enrichInput)

    // The request went to THIS instance's model (the registry routes tiers).
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.body.model).toBe(OPENAI_FAST_MODEL)
    // The port's system contract rode along with the prompt.
    const prompt = JSON.stringify(fake.requests[0]!.body.messages)
    expect(prompt).toContain("enrichment engine")
    expect(prompt).toContain("Row 1")

    expect(value.title).toBe("Brunner Gießkanne 5L")
    // Handle composed mechanically (title slug + natural-key-hash suffix).
    expect(value.handle).toBe(`brunner-giesskanne-5l-${HASH.slice(0, 8)}`)
    expect(value.attributes).toEqual({ Farbe: "rot" })
    expect(value.tags).toEqual(["gießkanne", "stahl"])
    expect(value.sourceRows).toEqual([1, 2])
    // Real usage from the API response, under the shared provider id.
    expect(usage).toEqual({
      providerId: "openai",
      model: OPENAI_FAST_MODEL,
      tokensIn: 120,
      tokensOut: 80,
    })
  })

  it("drops claims whose row/column pointers do not resolve (EC-075)", async () => {
    const fake = fakeEndpoint(() => completionContent(validEnrichOutput))
    const { value } = await provider(fake.fetch).enrich(enrichInput)

    // Only the claim pointing at an existing row AND column survives.
    expect(value.claims).toEqual([
      { text: "aus Stahlblech", sourceRowIndex: 1, sourceColumn: "Title" },
    ])
  })

  it("forces Needs Review below the Confidence threshold (EC-099)", async () => {
    const fake = fakeEndpoint(() => completionContent(validEnrichOutput))
    const { value } = await provider(fake.fetch).enrich(enrichInput)

    // Model said "ready"; category 30 and the missing-field reason say
    // otherwise — the port's gate wins.
    expect(value.status).toBe("needs_review")
    expect(value.reviewReasons.join(" ")).toContain("category")
    expect(value.reviewReasons.join(" ")).toMatch(
      /below the review threshold 70/
    )
  })

  it("prices real calls from real model prices, in integer micros", async () => {
    const usage = {
      providerId: "openai",
      model: OPENAI_FAST_MODEL,
      tokensIn: 1_000,
      tokensOut: 2_000,
    }
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out → 150µ$/600µ$ per 1k tokens.
    expect(costMicrosFor(usage)).toBe(150 + 1_200)
    // gpt-4o: $2.50/1M in, $10.00/1M out → 2_500µ$/10_000µ$ per 1k tokens.
    expect(costMicrosFor({ ...usage, model: OPENAI_STRONG_MODEL })).toBe(
      2_500 + 20_000
    )
    expect(
      costMicrosFor({
        ...usage,
        model: OPENAI_STRONG_MODEL,
        tokensIn: 333,
        tokensOut: 1,
      })
    ).toBe(Math.ceil((333 * 2_500) / 1_000) + Math.ceil((1 * 10_000) / 1_000))
  })
})

// ------------------------------------------------------------- registry --

describe("openai provider entries", () => {
  it("registers both tiers under one provider id and routes the tier's model", async () => {
    const fake = fakeEndpoint((request) =>
      completionContent({
        ...validEnrichOutput,
        claims: [], // row 1 exists for the fast call; keep it simple for both
      })
    )
    const registry = createProviderRegistry(
      openAIProviderEntries({
        apiKey: "test-key",
        fetch: fake.fetch,
        concurrency: 2,
      })
    )
    // One provider id across tiers — a Pause holds the provider, not a model.
    expect(registry.providerIdForTier("fast")).toBe("openai")
    expect(registry.providerIdForTier("strong")).toBe("openai")

    await registry.run("fast", (p) => p.enrich(enrichInput))
    await registry.run("strong", (p) => p.enrich(enrichInput))
    expect(fake.requests.map((request) => request.body.model)).toEqual([
      OPENAI_FAST_MODEL,
      OPENAI_STRONG_MODEL,
    ])
  })
})

// ------------------------------------------------- reliability (EC-082) --

describe("openai fault mapping", () => {
  it("maps 429 + Retry-After to rate_limited carrying the header value", async () => {
    const fake = fakeEndpoint(() => errorResponse(429, { "retry-after": "2" }))
    const error = await faultOf(provider(fake.fetch).enrich(enrichInput))
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.fault).toEqual({ class: "rate_limited", retryAfterMs: 2_000 })
  })

  it("maps 429 without a header to rate_limited with null Retry-After", async () => {
    const fake = fakeEndpoint(() => errorResponse(429))
    const error = await faultOf(provider(fake.fetch).enrich(enrichInput))
    expect(error.fault).toEqual({ class: "rate_limited", retryAfterMs: null })
  })

  it("maps 5xx to server_error and other 4xx to server_error with status", async () => {
    const serverError = fakeEndpoint(() => errorResponse(503))
    const thrown503 = await faultOf(
      provider(serverError.fetch).enrich(enrichInput)
    )
    expect(thrown503.fault).toEqual({ class: "server_error", status: 503 })

    // A bad key is a provider fault too — the machinery retries it into the
    // poison path instead of crashing the Worker.
    const unauthorized = fakeEndpoint(() => errorResponse(401))
    const thrown401 = await faultOf(
      provider(unauthorized.fetch).enrich(enrichInput)
    )
    expect(thrown401.fault).toEqual({ class: "server_error", status: 401 })
  })

  it("maps unusable model output to invalid_json (EC-081)", async () => {
    const fake = fakeEndpoint(() => chatCompletion("this is not json"))
    const error = await faultOf(provider(fake.fetch).enrich(enrichInput))
    expect(error.fault.class).toBe("invalid_json")
  })

  it("maps an aborted (timed-out) call to timeout", async () => {
    const timed = createOpenAIProvider({
      apiKey: "test-key",
      model: OPENAI_FAST_MODEL,
      fetch: hangingEndpoint(),
      timeoutMs: 25,
    })
    const error = await faultOf(timed.enrich(enrichInput))
    expect(error.fault).toEqual({ class: "timeout" })
  })
})

// ------------------------------------------------------------- translate --

describe("openai translate", () => {
  it("returns the translated fields and validates the round-trip", async () => {
    const fake = fakeEndpoint(() =>
      completionContent({
        title: "Gießkanne 5 l",
        description: "Robuste Gießkanne, Modell TP-100.",
        category: "Garten > Bewässerung",
      })
    )
    const { value, usage } = await provider(fake.fetch).translate(
      translateInput
    )

    expect(value.fields).toEqual({
      title: "Gießkanne 5 l",
      description: "Robuste Gießkanne, Modell TP-100.",
      category: "Garten > Bewässerung",
    })
    expect(usage.model).toBe(OPENAI_FAST_MODEL)
    const prompt = JSON.stringify(fake.requests[0]!.body.messages)
    expect(prompt).toContain("German (de)")
    expect(prompt).toContain("TP-100")
  })

  it("throws invalid_json when a protected token is lost (EC-089/EC-090)", async () => {
    const fake = fakeEndpoint(() =>
      completionContent({
        title: "Gießkanne 5 l",
        description: "Robuste Gießkanne, Modell weg.",
        category: "Garten > Bewässerung",
      })
    )
    const error = await faultOf(provider(fake.fetch).translate(translateInput))
    expect(error.fault.class).toBe("invalid_json")
  })

  it("throws invalid_json when HTML markup changes (EC-090)", async () => {
    const fake = fakeEndpoint(() =>
      completionContent({
        title: "Gießkanne 5 l",
        description: "Robuste <strong>Gießkanne</strong>, Modell TP-100.",
        category: "Garten > Bewässerung",
      })
    )
    const withMarkup = {
      ...translateInput,
      fields: {
        ...translateInput.fields,
        description: "Robuste Gießkanne, Modell TP-100.",
      },
    }
    const error = await faultOf(provider(fake.fetch).translate(withMarkup))
    expect(error.fault.class).toBe("invalid_json")
  })
})
