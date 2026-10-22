/**
 * The Demo Mode stub provider (spec: deterministic outputs — title composed
 * from cleaned fields, fixed Confidences, zero Claims — doubling as the
 * chaos-test double's baseline). Every output traces to input values; the
 * translate pass masks HTML tags, `{{placeholders}}`, numbers+units and
 * never-translate tokens so they survive the round-trip verbatim (EC-089,
 * EC-090) and post-validates that they did (EC-081: a violation is a
 * provider fault, not corrupt data).
 */
import {
  ProviderError,
  type EnrichInput,
  type EnrichmentResult,
  type FieldConfidence,
  type Provider,
  type ProviderCall,
  type ProviderUsage,
  type TranslateInput,
  type TranslateResult,
} from "./port"

export const STUB_PROVIDER_ID = "stub"
export const STUB_MODEL = "stub-demo-v1"

/** Below this per-field Confidence the enrichment gates Needs Review (EC-099). */
export const REVIEW_CONFIDENCE_THRESHOLD = 70

/** Fixed Confidences for grounded fields; sparse products score lower. */
const GROUNDED_CONFIDENCE: FieldConfidence = {
  title: 95,
  handle: 95,
  description: 90,
  category: 90,
  tags: 80,
  attributes: 90,
}
/** Composed without the corresponding source field — inference, not reading. */
const INFERRED_CONFIDENCE = { description: 55, category: 60 }

// ---------------------------------------------------------------- lexicon --

/** Demo lexicons (EC-093: same term every time). Words absent here pass through. */
const LEXICON: Record<"de" | "fr", Record<string, string>> = {
  de: {
    garden: "Garten",
    plant: "Pflanze",
    pot: "Topf",
    steel: "Stahl",
    durable: "langlebig",
    robust: "robust",
    watering: "gießen",
    with: "mit",
    and: "und",
    for: "für",
    indoor: "innen",
    outdoor: "außen",
    capacity: "Volumen",
    terracotta: "Terrakotta",
  },
  fr: {
    garden: "jardin",
    plant: "plante",
    pot: "pot",
    steel: "acier",
    durable: "durable",
    robust: "robuste",
    watering: "arrosage",
    with: "avec",
    and: "et",
    for: "pour",
    indoor: "intérieur",
    outdoor: "extérieur",
    capacity: "capacité",
    terracotta: "terracotta",
  },
}

// ------------------------------------------------------------------ enrich --

/** German-aware slug: ä/ö/ü/ß folded the way storefronts spell them. */
function slugify(text: string): string {
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

/** Tags: deduped source values in fixed order — nothing invented (EC-075). */
function sourceTags(input: EnrichInput): string[] {
  const candidates = [
    input.product.brand,
    input.product.category,
    ...Object.values(input.attributes),
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const value = candidate?.trim().toLowerCase()
    if (value) seen.add(value)
  }
  return [...seen].slice(0, 8)
}

/** Description composed from attribute values when the sheet had none. */
function composedDescription(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes).map(
    ([name, value]) => `${name} ${value}`
  )
  return entries.length > 0 ? `Details: ${entries.join(" · ")}` : ""
}

function enrichDeterministically(input: EnrichInput): EnrichmentResult {
  const { product, attributes } = input
  const baseTitle =
    product.title.trim().length > 0 ? product.title : product.naturalKey
  const brand = product.brand?.trim() ?? ""
  const carriesBrand =
    brand.length > 0 && baseTitle.toLowerCase().includes(brand.toLowerCase())
  const title =
    carriesBrand || brand.length === 0 ? baseTitle : `${brand} ${baseTitle}`

  const slug = slugify(title)
  const handle = `${slug.length > 0 ? slug : "product"}-${product.naturalKeyHash.slice(0, 8)}`

  const hasSourceDescription =
    product.description !== null && product.description.trim().length > 0
  const description = hasSourceDescription
    ? product.description!
    : composedDescription(attributes)
  const hasSourceCategory =
    product.category !== null && product.category.trim().length > 0
  const category = hasSourceCategory ? product.category! : ""

  const confidence: FieldConfidence = {
    ...GROUNDED_CONFIDENCE,
    description: hasSourceDescription
      ? GROUNDED_CONFIDENCE.description
      : INFERRED_CONFIDENCE.description,
    category: hasSourceCategory
      ? GROUNDED_CONFIDENCE.category
      : INFERRED_CONFIDENCE.category,
  }

  const reviewReasons: string[] = []
  if (!hasSourceDescription) {
    reviewReasons.push(
      `description: no source description — composed from attributes ` +
        `(confidence ${confidence.description} < ${REVIEW_CONFIDENCE_THRESHOLD}).`
    )
  }
  if (!hasSourceCategory) {
    reviewReasons.push(
      `category: no source category to ground the field ` +
        `(confidence ${confidence.category} < ${REVIEW_CONFIDENCE_THRESHOLD}).`
    )
  }
  for (const field of ["title", "handle", "tags", "attributes"] as const) {
    if (confidence[field] < REVIEW_CONFIDENCE_THRESHOLD) {
      reviewReasons.push(
        `${field}: confidence ${confidence[field]} below the review threshold ` +
          `${REVIEW_CONFIDENCE_THRESHOLD}.`
      )
    }
  }

  return {
    title,
    handle,
    description,
    category,
    tags: sourceTags(input),
    attributes: { ...attributes },
    confidence,
    status:
      reviewReasons.length > 0 ? ("needs_review" as const) : ("ready" as const),
    // EC-075: the stub invents nothing — no claims, ever.
    claims: [],
    reviewReasons,
    sourceRows: [...input.sourceRows].sort((a, b) => a - b),
  }
}

// --------------------------------------------------------------- translate --

const MASK_OPEN = "\uE000"
const MASK_CLOSE = "\uE001"

/**
 * Mask everything that must survive verbatim (EC-089/EC-090/EC-097): HTML
 * tags, `{{placeholders}}`, numbers with their units, size codes, and the
 * caller's identity tokens. ONE combined pass — sentinels themselves are
 * never re-scanned, so stashing never nests. Returns the masked text and the
 * stashed originals in stash order.
 */
function maskProtected(
  text: string,
  protectedTokens: string[]
): { masked: string; stashed: string[] } {
  const stashed: string[] = []
  const stash = (match: string): string => {
    stashed.push(match)
    return `${MASK_OPEN}${stashed.length - 1}${MASK_CLOSE}`
  }
  const alternatives = [
    "<[^>]+>",
    "\\{\\{[^{}]*\\}\\}",
    "\\d[\\d.,]*(?:\\s?(?:mm|cm|km|dm|ml|cl|dl|l|g|kg|t|°C|%|€|£|\\$))?",
    "\\b(?:XXXS|XXS|XS|XXXL|XXL|XL|S|M|L)\\b",
    ...protectedTokens.filter((token) => token.length > 0).map(escapeRegExp),
  ]
  const masked = text.replace(new RegExp(alternatives.join("|"), "gi"), stash)
  return { masked, stashed }
}

/** Regex-escape so caller-supplied tokens match literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function unmask(masked: string, stashed: string[]): string {
  return masked.replace(
    /\uE000(\d+)\uE001/g,
    (_, index) => stashed[Number(index)] ?? ""
  )
}

/** Fixed-lexicon pass over the unmasked words; unknown words survive. */
function translateWords(text: string, lexicon: Record<string, string>): string {
  return text
    .split(/([^A-Za-zÀ-ÿ]+)/)
    .map((part) => {
      const word = lexicon[part.toLowerCase()]
      return word ?? part
    })
    .join("")
}

/** EC-091: FrenchNBSP before `: ; ! ?` — on the word layer, pre-unmask. */
function frenchTypography(text: string): string {
  return text.replace(/ +([!?:;])/g, "\u00A0$1")
}

/**
 * Post-validation (EC-081/EC-089/EC-090): the tag sequence is unchanged and
 * every stashed token survived verbatim. A violation is a provider fault —
 * the handler retries instead of persisting corrupt data.
 */
function validateRoundTrip(
  field: string,
  source: string,
  output: string,
  stashed: string[]
): void {
  const sourceTags = source.match(/<[^>]+>/g) ?? []
  const outputTags = output.match(/<[^>]+>/g) ?? []
  if (
    sourceTags.length !== outputTags.length ||
    sourceTags.some((tag, index) => tag !== outputTags[index])
  ) {
    throw new ProviderError({
      class: "invalid_json",
      detail: `translate post-validation failed for field "${field}": HTML tag set changed (EC-090)`,
    })
  }
  for (const token of stashed) {
    if (!output.includes(token)) {
      throw new ProviderError({
        class: "invalid_json",
        detail: `translate post-validation failed for field "${field}": protected token ${JSON.stringify(token)} lost (EC-089/EC-090)`,
      })
    }
  }
}

function translateDeterministically(input: TranslateInput): TranslateResult {
  const lexicon = LEXICON[input.locale]
  const protectedTokens = input.brand
    ? [...input.protectedTokens, input.brand]
    : input.protectedTokens
  const fields: Partial<Record<keyof typeof input.fields, string>> = {}
  for (const [field, source] of Object.entries(input.fields) as Array<
    [keyof typeof input.fields, string]
  >) {
    const { masked, stashed } = maskProtected(source, protectedTokens)
    let translated = translateWords(masked, lexicon)
    if (input.locale === "fr") translated = frenchTypography(translated)
    const output = unmask(translated, stashed)
    validateRoundTrip(field, source, output, stashed)
    fields[field] = output
  }
  return { fields }
}

// ------------------------------------------------------------------ provider --

function usageOf(value: unknown, input: unknown): ProviderUsage {
  const tokensIn = Math.ceil(JSON.stringify(input).length / 4)
  const tokensOut = Math.ceil(JSON.stringify(value).length / 4)
  return {
    providerId: STUB_PROVIDER_ID,
    model: STUB_MODEL,
    tokensIn,
    tokensOut,
  }
}

/** The Demo Mode provider: deterministic, keyless, zero Claims. */
export function createStubProvider(): Provider {
  return {
    id: STUB_PROVIDER_ID,
    async enrich(input: EnrichInput): Promise<ProviderCall<EnrichmentResult>> {
      const value = enrichDeterministically(input)
      return { value, usage: usageOf(value, input) }
    },
    async translate(
      input: TranslateInput
    ): Promise<ProviderCall<TranslateResult>> {
      const value = translateDeterministically(input)
      return { value, usage: usageOf(value, input) }
    },
  }
}
