/**
 * The provider PORT (spec: Testing Decisions — the only injection point for
 * AI providers). Enrich and translate operations, the failure classes the
 * chaos stub drives (Ticket 6), per-call usage, and the routing tier derived
 * from the Messiness Score. Demo Mode treats tiers identically; the shape
 * exists so real providers can slot in without touching handlers.
 *
 * Handlers see faults only as thrown {@link ProviderError}s — the Job
 * machinery (ADR-0003) turns them into retries and, eventually, a Row Ledger
 * Failed-with-reason. Pause/backoff policies key on `fault.class` (EC-082).
 */

/** Routing tier — assigned from the Messiness Score signal. */
export type RoutingTier = "fast" | "strong"

/** Deterministic tier cut: 50+ needs the strong model (GLOSSARY: Messiness Score). */
export const STRONG_TIER_THRESHOLD = 50

/**
 * Below this per-field Confidence enrichment gates Needs Review (EC-099,
 * GLOSSARY: Confidence). Port-level because every provider — Demo stub and
 * real — must honor the same gate, not just the stub's self-scoring.
 */
export const REVIEW_CONFIDENCE_THRESHOLD = 70

export function routingTierFor(messinessScore: number): RoutingTier {
  return messinessScore >= STRONG_TIER_THRESHOLD ? "strong" : "fast"
}

/**
 * The Job's plan-time routing tier, when it carries a valid one — a Job
 * stamped at plan time routes ALL its calls to the provider its claim gate
 * knows about; `null` (unstamped/legacy Jobs) leaves routing per call.
 */
export function routingTierFrom(value: string | null): RoutingTier | null {
  return value === "fast" || value === "strong" ? value : null
}

/**
 * Provider failure classes (EC-082's three behaviors + EC-081 structured
 * output). `rate_limited` carries the honored Retry-After; `invalid_json`
 * covers malformed/unusable provider output INCLUDING the translate
 * post-validation failure (EC-089/EC-090) — a provider fault, never corrupt
 * data.
 */
export type ProviderFault =
  | { class: "rate_limited"; retryAfterMs: number | null }
  | { class: "timeout" }
  | { class: "server_error"; status: number | null }
  | { class: "invalid_json"; detail: string }

export class ProviderError extends Error {
  readonly fault: ProviderFault

  constructor(fault: ProviderFault, message?: string) {
    super(message ?? `provider fault: ${fault.class}`)
    this.name = "ProviderError"
    this.fault = fault
  }
}

/** The brief's enrichable fields — exactly the structured output shape. */
export const ENRICH_FIELDS = [
  "title",
  "handle",
  "description",
  "category",
  "tags",
  "attributes",
] as const

export type EnrichField = (typeof ENRICH_FIELDS)[number]

/** Per-field Confidence, 0–100 (GLOSSARY: Confidence). */
export type FieldConfidence = Record<EnrichField, number>

/**
 * The brief's JSON shape for one enriched Product: title, handle,
 * description, category, tags, attributes, per-field confidence, status,
 * claims, source rows.
 */
export interface EnrichmentResult {
  title: string
  handle: string
  description: string
  category: string
  tags: string[]
  attributes: Record<string, string>
  confidence: FieldConfidence
  status: "ready" | "needs_review"
  /**
   * EC-075: assertions extracted from source only — the stub invents none;
   * the real provider's schema + validation enforce the same rule. Every
   * Claim points at its Sheet Row (`sourceRowIndex`, 1-based) and, when the
   * value came from one cell, that cell's column header (`sourceColumn`).
   */
  claims: Array<{
    text: string
    sourceRowIndex: number
    sourceColumn?: string
  }>
  /** Why gating flagged this Product (empty when `ready`). */
  reviewReasons: string[]
  /** 1-based Sheet Row indexes the Product was grouped from. */
  sourceRows: number[]
}

/** The cleaned, grouped facts one enrich call sees. */
export interface EnrichInput {
  product: {
    naturalKey: string
    naturalKeyHash: string
    identityKind: "code" | "title"
    title: string
    brand: string | null
    category: string | null
    description: string | null
    gtin: string | null
  }
  /** Merged variant-axis values by header (display form, EC-063). */
  attributes: Record<string, string>
  /** Matched photos (EC-072) — context, never a claim source. */
  photoCount: number
  /** Messiness Score 0–100: decides the routing tier, nothing else in Demo Mode. */
  messiness: number
  sourceRows: number[]
  /**
   * The raw Sheet Row cells behind `sourceRows` — column header → cell text.
   * The evidence real providers ground Claims and conflicting-row decisions
   * in. Optional: Demo Mode and test doubles construct inputs without them.
   */
  sourceRowValues?: Array<{ rowIndex: number; values: Record<string, string> }>
}

/** The fields translate localizes (storefront text; EC-098 batches them). */
export const TRANSLATE_FIELDS = ["title", "description", "category"] as const

export type TranslateField = (typeof TRANSLATE_FIELDS)[number]

export interface TranslateInput {
  locale: "de" | "fr"
  /** Non-empty enriched source texts by field; empty fields are skipped. */
  fields: Partial<Record<TranslateField, string>>
  brand: string | null
  /** Never-translate identity tokens (SKUs/GTINs, EC-089). */
  protectedTokens: string[]
}

export interface TranslateResult {
  fields: Partial<Record<TranslateField, string>>
}

/** Synthetic per-call usage (spec: usage rows so cost has shape). */
export interface ProviderUsage {
  /** Which registered provider served the call. */
  providerId: string
  model: string
  tokensIn: number
  tokensOut: number
}

/** One provider call's outcome + usage, recorded per call. */
export interface ProviderCall<T> {
  value: T
  usage: ProviderUsage
}

export interface Provider {
  readonly id: string
  enrich(input: EnrichInput): Promise<ProviderCall<EnrichmentResult>>
  translate(input: TranslateInput): Promise<ProviderCall<TranslateResult>>
}

/**
 * µ-price per model: micro-currency units per 1k tokens — integer math
 * (micros per 1k), never a float. Demo Mode's synthetic stub price and the
 * real OpenAI list prices ($0.15/$0.60 per 1M tokens for gpt-4o-mini,
 * $2.50/$10.00 per 1M tokens for gpt-4o) live in ONE table so every call,
 * synthetic or real, is priced by the same integer formula.
 */
const MODEL_PRICES: Record<string, { inMicros: number; outMicros: number }> = {
  "stub-demo-v1": { inMicros: 50, outMicros: 200 },
  "gpt-4o-mini": { inMicros: 150, outMicros: 600 },
  "gpt-4o": { inMicros: 2_500, outMicros: 10_000 },
}

/** Integer micro cost for one call, from the model's price entry. */
export function costMicrosFor(usage: ProviderUsage): number {
  const price = MODEL_PRICES[usage.model]
  if (!price) return 0
  return (
    Math.ceil((usage.tokensIn * price.inMicros) / 1_000) +
    Math.ceil((usage.tokensOut * price.outMicros) / 1_000)
  )
}

/**
 * Storefront-slug folding shared by every provider (Demo Mode stub and real
 * alike): handles key publications, so both providers must compose them the
 * same way. German ä/ö/ü/ß fold the way storefronts spell them.
 */
export function slugifyHandle(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
