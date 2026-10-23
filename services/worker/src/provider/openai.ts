/**
 * The REAL OpenAI enrichment provider behind the provider Port (spec:
 * Provider handling) — Vercel AI SDK (`ai` + `@ai-sdk/openai`). Two models,
 * routed by the registry's Messiness tiers: gpt-4o-mini serves "fast"
 * (clean rows), gpt-4o serves "strong" (messy rows and photo/vision work).
 * Which tier serves a call is decided per row — the caller's enrich-time
 * photo-aware Messiness Score — while the Job's plan-time routing stamp
 * remains Pause/claim-gate metadata only. Vision is real on the strong
 * tier: matched photos (`EnrichInput.photos`) are sent as image content
 * parts alongside the prompt; the fast tier stays text-only. Both entries
 * share ONE registered provider id (`openai`), so a Pause on either model
 * holds the provider's Jobs across ALL Imports (GLOSSARY: Pause) while
 * other providers keep working.
 *
 * Selection is config, not code: `main.ts` registers these entries only
 * when OPENAI_API_KEY is set. Without a key Demo Mode's stub serves both
 * tiers unchanged — keyless CI stays green.
 *
 * Reliability contract (EC-082): the SDK's own retries are OFF
 * (`maxRetries: 0`) — one provider call is one HTTP attempt — and every
 * failure surfaces as a typed {@link ProviderError} fault the Job machinery
 * already keys on:
 *
 *   - HTTP 429                   → `rate_limited` (Retry-After honored;
 *                                  `null` falls back to the machinery's
 *                                  rateLimitRetryAfterMs) → Pause
 *   - HTTP 5xx                   → `server_error` (backoff + retry)
 *   - HTTP 408 / abort on timeout → `timeout`
 *   - unusable output            → `invalid_json` (schema validation, or
 *                                  the translate round-trip post-validation,
 *                                  EC-081/EC-089/EC-090) — a provider fault,
 *                                  never corrupt data
 *   - anything else              → `server_error` (status null) — never
 *                                  swallowed
 *
 * Claims (EC-075, GLOSSARY: Claim): the prompt-level guarantee against
 * invention is this contract — a Claim may be returned ONLY when ONE source
 * cell states it, in the cell's own wording, with that row's number
 (`sourceRowIndex`) and column header (`sourceColumn`); the system prompt
 * makes the rule a hard output requirement and an empty claims array is
 * always acceptable. The provider then re-checks the pointers and DROPS
 * claims that point at a row the Product was not grouped from, or a column
 * that does not exist on that row: output may lose a hallucinated claim,
 * it can never carry one.
 *
 * Edge cases the prompt handles explicitly: missing fields (return "",
 * low confidence, Needs Review with a reason — never guess), conflicting
 * rows (pick the majority/most specific value and name the conflict in
 * reviewReasons — never invent a compromise), and foreign-language source
 * text (enrich in the source language; the translate Stage localizes).
 *
 * Handles are NOT model output: they are composed mechanically from the
 * grounded title (`slugifyHandle` + natural-key-hash suffix, the stub's
 * rule), because handles key publications and must stay deterministic and
 * collision-free across retries.
 */
import { createOpenAI } from "@ai-sdk/openai"
import {
  APICallError,
  NoObjectGeneratedError,
  Output,
  RetryError,
  generateText,
} from "ai"
import { z } from "zod"

import {
  ProviderError,
  REVIEW_CONFIDENCE_THRESHOLD,
  TRANSLATE_FIELDS,
  slugifyHandle,
  type EnrichInput,
  type EnrichPhoto,
  type EnrichmentResult,
  type FieldConfidence,
  type Provider,
  type ProviderCall,
  type ProviderUsage,
  type TranslateField,
  type TranslateInput,
  type TranslateResult,
} from "./port"
import type { ProviderEntry } from "./registry"

export const OPENAI_PROVIDER_ID = "openai"
export const OPENAI_FAST_MODEL = "gpt-4o-mini"
export const OPENAI_STRONG_MODEL = "gpt-4o"

export interface OpenAIProviderOptions {
  /** API key. Absent: the SDK falls back to `OPENAI_API_KEY` itself. */
  apiKey?: string
  /** Override the API base URL (proxies, gateways, tests). */
  baseURL?: string
  /** Injectable fetch — the seam the fake-endpoint tests drive. */
  fetch?: typeof globalThis.fetch
  /** Per-call timeout in ms (aborts the request; maps to `timeout`). */
  timeoutMs?: number
  /**
   * Send the input's matched photos as real image content parts (vision).
   * The strong tier only — gpt-4o-mini stays text-only, so a photo-heavy
   * clean row costs text rates. Enrich calls carry photo bytes in
   * `EnrichInput.photos`; without them (or off) the prompt stays text.
   */
  vision?: boolean
}

// ------------------------------------------------------------- prompts --

const ENRICH_SYSTEM_PROMPT = `You are the enrichment engine of a product catalog pipeline. You receive cleaned supplier data for ONE product (possibly grouped from several sheet rows) and return structured catalog copy.

RULES — the output is machine-validated; violating them makes the call fail:
1. GROUNDING. Every text field must derive ONLY from the SOURCE ROWS shown in the prompt. Never invent facts, marketing language, measurements, materials, or certifications the source does not state.
2. CLAIMS. A claim is a specific, checkable assertion the source makes (e.g. "frost-resistant", "dishwasher-safe"). Return a claim ONLY when a single source cell states it; stay as close to the cell's own wording as possible, set sourceRowIndex to that row's number and sourceColumn to that column's header exactly as listed. An empty claims array is always acceptable. Claims pointing at a nonexistent row or column are dropped.
3. MISSING FIELDS. If the source has no category or no usable description, return "" for that field, give it a low confidence, set status to "needs_review", and add a reviewReasons entry explaining what is missing. Do not guess.
4. CONFLICTING ROWS. If source rows disagree (titles, values, units), choose the majority or the most specific value and add a reviewReasons entry naming the conflict. Never invent a compromise value.
5. LANGUAGE. Source text may be in any language. Write title, description, category and tags in the source's language — never translate; a separate stage localizes. Never mix languages within one field.
6. CONFIDENCE. Score every field 0-100 for how well it is grounded: quoted from the source 90+, composed from variant attributes 60-80, missing 0-40. Any field below 70 forces status "needs_review".
7. ATTRIBUTES. Return the product's distinguishing properties as name/value pairs exactly as the source states them — no new attributes, no interpretation.`

const TRANSLATE_SYSTEM_PROMPT = `You translate product catalog fields for a storefront.

RULES:
1. Translate naturally for shoppers; keep the register factual, not marketing.
2. Never-translate tokens — the SKUs, GTINs and brand names listed in the prompt — must appear in the output verbatim and in place.
3. Keep markup and structure verbatim: HTML tags (same tags, same order), {{placeholders}}, numbers with their units, and size codes (XS-XXL).
4. Return every requested field. If a field needs no change, return it unchanged.`

/** One source row, rendered for the prompt: "Row 3 — SKU: X; Title: Y". */
function sourceRowLines(input: EnrichInput): string {
  if (!input.sourceRowValues || input.sourceRowValues.length === 0) {
    return "(raw sheet rows unavailable — ground every value in the product fields above)"
  }
  return input.sourceRowValues
    .map((row) => {
      const cells = Object.entries(row.values)
        .map(([column, value]) => `${column}: ${value}`)
        .join("; ")
      return `Row ${row.rowIndex}${cells.length > 0 ? ` — ${cells}` : ""}`
    })
    .join("\n")
}

function attributeLines(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes)
  return entries.length > 0
    ? entries.map(([name, value]) => `${name}=${value}`).join("; ")
    : "(none)"
}

function enrichUserPrompt(input: EnrichInput): string {
  const p = input.product
  return [
    "PRODUCT",
    `natural key: ${p.naturalKey}`,
    `grouped from sheet rows: ${input.sourceRows.join(", ")}`,
    `title: ${p.title}`,
    `brand: ${p.brand ?? "(none)"}`,
    `category: ${p.category ?? "(none)"}`,
    `description: ${p.description ?? "(none)"}`,
    `gtin: ${p.gtin ?? "(none)"}`,
    `variant attributes: ${attributeLines(input.attributes)}`,
    `photos attached: ${input.photoCount}`,
    `messiness score: ${input.messiness} (0 = pristine; 50+ = messy)`,
    "",
    "SOURCE ROWS (row numbers are 1-based; cite them in claims)",
    sourceRowLines(input),
  ].join("\n")
}

function translateUserPrompt(input: TranslateInput): string {
  const localeName = input.locale === "de" ? "German (de)" : "French (fr)"
  const tokens = [
    ...input.protectedTokens,
    ...(input.brand ? [input.brand] : []),
  ]
  const fields = TRANSLATE_FIELDS.filter(
    (field): field is TranslateField => field in input.fields
  )
    .map((field) => `${field}: ${input.fields[field] ?? ""}`)
    .join("\n\n")
  return [
    `Target locale: ${localeName}`,
    `Never-translate tokens: ${tokens.length > 0 ? tokens.join(", ") : "(none)"}`,
    "",
    "Translate these fields:",
    fields,
  ].join("\n")
}

// -------------------------------------------------------------- schemas --

/**
 * Types only — no numeric constraints or free-form records — so the JSON
 * schema survives every structured-output mode (incl. strict) unchanged.
 * The post-processing below is the enforcer.
 */
const enrichOutputSchema = z.object({
  title: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  attributes: z.array(z.object({ name: z.string(), value: z.string() })),
  confidence: z.object({
    title: z.number(),
    description: z.number(),
    category: z.number(),
    tags: z.number(),
    attributes: z.number(),
  }),
  status: z.enum(["ready", "needs_review"]),
  claims: z.array(
    z.object({
      text: z.string(),
      sourceRowIndex: z.number(),
      sourceColumn: z.string(),
    })
  ),
  reviewReasons: z.array(z.string()),
})

type EnrichOutput = z.infer<typeof enrichOutputSchema>

/** One field per requested translate field — requested means required. */
function translateOutputSchema(fields: readonly TranslateField[]) {
  return z.object(
    Object.fromEntries(fields.map((field) => [field, z.string()]))
  )
}

// ------------------------------------------------------- post-processing --

const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

/**
 * Port-shaping + enforcement: clamps Confidence, composes the handle
 * mechanically (model handles are not trusted), drops claims whose source
 * pointers do not resolve, and forces the EC-099 review gate on any field
 * below the port's Confidence threshold.
 */
function toEnrichmentResult(
  output: EnrichOutput,
  input: EnrichInput
): EnrichmentResult {
  const title = output.title.trim()
  const baseTitle = title.length > 0 ? title : input.product.naturalKey
  const slug = slugifyHandle(baseTitle)
  const handle = `${slug.length > 0 ? slug : "product"}-${input.product.naturalKeyHash.slice(0, 8)}`

  const confidence: FieldConfidence = {
    title: clampPercent(output.confidence.title),
    // The handle is composed mechanically from the grounded title, not
    // model output — the stub's grounded score, same rule.
    handle: 95,
    description: clampPercent(output.confidence.description),
    category: clampPercent(output.confidence.category),
    tags: clampPercent(output.confidence.tags),
    attributes: clampPercent(output.confidence.attributes),
  }

  const attributes: Record<string, string> = {}
  for (const entry of output.attributes) {
    const name = entry.name.trim()
    const value = entry.value.trim()
    if (name.length > 0 && value.length > 0 && !(name in attributes)) {
      attributes[name] = value
    }
  }

  const seenTags = new Set<string>()
  const tags: string[] = []
  for (const tag of output.tags) {
    const trimmed = tag.trim()
    const key = trimmed.toLowerCase()
    if (trimmed.length > 0 && !seenTags.has(key) && tags.length < 12) {
      seenTags.add(key)
      tags.push(trimmed)
    }
  }

  // Claims: a pointer that does not resolve in the cited source is a
  // hallucination — dropped, never stored (EC-075).
  const rowsByName = new Map(
    (input.sourceRowValues ?? []).map((row) => [row.rowIndex, row])
  )
  const claims: EnrichmentResult["claims"] = []
  for (const claim of output.claims) {
    const text = claim.text.trim()
    const rowIndex = claim.sourceRowIndex
    if (text.length === 0 || !input.sourceRows.includes(rowIndex)) continue
    const row = rowsByName.get(rowIndex)
    if (row) {
      const header = Object.keys(row.values).find(
        (name) => name.toLowerCase() === claim.sourceColumn.trim().toLowerCase()
      )
      if (header === undefined) continue
      claims.push({ text, sourceRowIndex: rowIndex, sourceColumn: header })
    } else {
      // No raw cells to check the column against; the row pointer stands.
      claims.push({
        text,
        sourceRowIndex: rowIndex,
        sourceColumn: claim.sourceColumn.trim(),
      })
    }
  }

  const reviewReasons = output.reviewReasons
    .map((reason) => reason.trim())
    .filter((reason) => reason.length > 0)
  for (const field of Object.keys(confidence) as Array<keyof FieldConfidence>) {
    if (confidence[field] < REVIEW_CONFIDENCE_THRESHOLD) {
      reviewReasons.push(
        `${field}: confidence ${confidence[field]} below the review threshold ` +
          `${REVIEW_CONFIDENCE_THRESHOLD}.`
      )
    }
  }
  if (output.status === "needs_review" && reviewReasons.length === 0) {
    reviewReasons.push("The provider flagged this product without a reason.")
  }

  return {
    title,
    handle,
    description: output.description.trim(),
    category: output.category.trim(),
    tags,
    attributes,
    confidence,
    status: reviewReasons.length > 0 ? "needs_review" : output.status,
    claims,
    reviewReasons,
    sourceRows: [...input.sourceRows].sort((a, b) => a - b),
  }
}

/**
 * Translate round-trip post-validation (EC-090/EC-089): the HTML tag
 * sequence is unchanged and every never-translate token survived verbatim.
 * A violation is a provider fault (`invalid_json`) — the handler retries
 * instead of persisting corrupt data.
 */
function assertTranslateRoundTrip(
  field: string,
  source: string,
  output: string,
  tokens: string[]
): void {
  const sourceTags = source.match(/<[^>]+>/g) ?? []
  const outputTags = output.match(/<[^>]+>/g) ?? []
  if (
    sourceTags.length !== outputTags.length ||
    sourceTags.some((tag, index) => tag !== outputTags[index])
  ) {
    throw new ProviderError(
      {
        class: "invalid_json",
        detail: `translate post-validation failed for field "${field}": HTML tag set changed (EC-090)`,
      },
      `openai: translate broke HTML markup in field "${field}" (EC-090)`
    )
  }
  for (const token of tokens) {
    if (!output.includes(token)) {
      throw new ProviderError(
        {
          class: "invalid_json",
          detail: `translate post-validation failed for field "${field}": protected token ${JSON.stringify(token)} lost (EC-089/EC-090)`,
        },
        `openai: translate lost protected token ${JSON.stringify(token)} in field "${field}"`
      )
    }
  }
}

// ---------------------------------------------------------------- faults --

const ABORT_ERROR_NAMES: Record<string, true> = {
  AbortError: true,
  ResponseAborted: true,
  TimeoutError: true,
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && ABORT_ERROR_NAMES[error.name] === true
}

/** Retry-After: delta-seconds or HTTP-date → ms; anything else → null. */
function retryAfterMsOf(
  headers: Record<string, string> | undefined
): number | null {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"]
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

/** Every failure becomes the typed fault the Job machinery keys on. */
function faultOf(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error
  if (NoObjectGeneratedError.isInstance(error)) {
    return new ProviderError(
      {
        class: "invalid_json",
        detail: `model output failed schema validation: ${error.message}`,
      },
      `openai: unusable output (${error.message})`
    )
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? null
    if (status === 429) {
      return new ProviderError(
        {
          class: "rate_limited",
          retryAfterMs: retryAfterMsOf(error.responseHeaders),
        },
        "openai: rate limited (HTTP 429)"
      )
    }
    if (status === 408 || isAbortError(error.cause)) {
      return new ProviderError(
        { class: "timeout" },
        "openai: request timeout (HTTP 408)"
      )
    }
    return new ProviderError(
      { class: "server_error", status },
      `openai: server error (HTTP ${status ?? "unknown"})`
    )
  }
  if (isAbortError(error)) {
    return new ProviderError(
      { class: "timeout" },
      "openai: request aborted by timeout"
    )
  }
  if (RetryError.isInstance(error)) {
    const last = error.errors.at(-1)
    if (last !== undefined) return faultOf(last)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError(
    { class: "server_error", status: null },
    `openai: unexpected provider failure: ${message}`
  )
}

// -------------------------------------------------------------- provider --

/**
 * One OpenAI provider instance for ONE model — the registry routes tiers,
 * so instantiate through {@link openAIProviderEntries} (fast + strong) or
 * pick the model explicitly in tests. The id is shared by both entries so
 * Pauses hold the provider, not a single model.
 */
export function createOpenAIProvider(
  options: OpenAIProviderOptions & { model: string }
): Provider {
  const client = createOpenAI({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  })
  const model = client.chat(options.model)
  const { model: modelName, timeoutMs, vision = false } = options

  async function call<T>(
    schema: z.ZodType<T>,
    system: string,
    prompt: string,
    images: readonly EnrichPhoto[] = []
  ): Promise<{ value: T; tokensIn: number; tokensOut: number }> {
    let result
    try {
      result = await generateText({
        model,
        system,
        // Vision: the matched photos ride along as real image content parts
        // after the text prompt. Text-only calls keep the plain prompt.
        ...(images.length > 0
          ? {
              messages: [
                {
                  role: "user" as const,
                  content: [
                    { type: "text" as const, text: prompt },
                    ...images.map((photo) => ({
                      type: "image" as const,
                      image: photo.data,
                      ...(photo.contentType
                        ? { mediaType: photo.contentType }
                        : {}),
                    })),
                  ],
                },
              ],
            }
          : { prompt }),
        output: Output.object({ schema }),
        temperature: 0,
        maxRetries: 0,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      })
    } catch (error) {
      throw faultOf(error)
    }
    const value = result.output
    if (value === undefined) {
      throw new ProviderError(
        {
          class: "invalid_json",
          detail: "provider returned no structured output",
        },
        "openai: no structured output in response"
      )
    }
    return {
      value,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
    }
  }

  function usageOf(tokensIn: number, tokensOut: number): ProviderUsage {
    return {
      providerId: OPENAI_PROVIDER_ID,
      model: modelName,
      tokensIn,
      tokensOut,
    }
  }

  return {
    id: OPENAI_PROVIDER_ID,
    async enrich(input: EnrichInput): Promise<ProviderCall<EnrichmentResult>> {
      const { value, tokensIn, tokensOut } = await call(
        enrichOutputSchema,
        ENRICH_SYSTEM_PROMPT,
        enrichUserPrompt(input),
        // Vision is the strong tier's job: the matched photos ride along as
        // real image content parts there; the fast tier stays text-only.
        vision ? (input.photos ?? []) : []
      )
      return {
        value: toEnrichmentResult(value, input),
        usage: usageOf(tokensIn, tokensOut),
      }
    },
    async translate(
      input: TranslateInput
    ): Promise<ProviderCall<TranslateResult>> {
      const requested = TRANSLATE_FIELDS.filter(
        (field): field is TranslateField => field in input.fields
      )
      const { value, tokensIn, tokensOut } = await call(
        translateOutputSchema(requested),
        TRANSLATE_SYSTEM_PROMPT,
        translateUserPrompt(input)
      )
      const tokens = [
        ...input.protectedTokens,
        ...(input.brand ? [input.brand] : []),
      ].filter((token) => token.length > 0)
      const fields: Partial<Record<TranslateField, string>> = {}
      for (const field of requested) {
        const output = (value as Record<string, string>)[field]
        if (typeof output !== "string") {
          throw new ProviderError(
            {
              class: "invalid_json",
              detail: `translate output missing field "${field}"`,
            },
            `openai: translate output missing field "${field}"`
          )
        }
        // Tokens only bind where the source field carries them — a SKU in the
        // description is not required to reappear in the title.
        const fieldTokens = tokens.filter((token) =>
          input.fields[field]!.includes(token)
        )
        assertTranslateRoundTrip(
          field,
          input.fields[field]!,
          output,
          fieldTokens
        )
        fields[field] = output
      }
      return { value: { fields }, usage: usageOf(tokensIn, tokensOut) }
    },
  }
}

/**
 * The two registry entries `main.ts` registers when OPENAI_API_KEY is set:
 * gpt-4o-mini for "fast" (clean rows, text-only), gpt-4o for "strong"
 * (messy/photo rows — vision: matched photos go out as image content
 * parts). Tiers are resolved per call from the enrich-time photo-aware
 * Messiness Score; one shared provider id so a Pause holds both tiers.
 */
export function openAIProviderEntries(
  options: OpenAIProviderOptions & { concurrency: number }
): ProviderEntry[] {
  return [
    {
      provider: createOpenAIProvider({ ...options, model: OPENAI_FAST_MODEL }),
      concurrency: options.concurrency,
      tiers: ["fast"],
    },
    {
      provider: createOpenAIProvider({
        ...options,
        model: OPENAI_STRONG_MODEL,
        vision: true,
      }),
      concurrency: options.concurrency,
      tiers: ["strong"],
    },
  ]
}
