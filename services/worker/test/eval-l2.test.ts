/**
 * Layer 2 scoring unit tests (Ticket #20): loose grading rules and the
 * EC-075 claim-traceability-as-error rule, over a synthetic EvalRun and a
 * fake provider's enrichment output — no database, no API key.
 */
import { describe, expect, it } from "vitest"

import {
  categoryMatches,
  gradeProduct,
  goldCategory,
  sampleProducts,
  sourceTextFor,
  titleMatches,
  tokens,
  type EvalRun,
  type GoldProduct,
} from "../scripts/eval-score-l2.js"

const RUN: EvalRun = {
  gold: { sheet: "s", products: [], quantities: [], parkedPhotos: [] },
  header: ["Artikelnummer", "Titel", "Kategorie", "Beschreibung"],
  products: [],
  variants: [],
  enrichments: [],
  matched: [],
  parked: [],
  cleaned: [
    {
      row_index: 1,
      values: [
        { kind: "text", value: "TP-100-R", key: "tp-100-r" },
        { kind: "text", value: "Gießkanne 5 L", key: "gießkanne 5 l" },
        { kind: "text", value: "Garten > Gießen", key: "garten > gießen" },
        { kind: "text", value: "Robuster Stahlkörper, 5 Liter.", key: "x" },
      ],
    },
    {
      row_index: 2,
      values: [
        { kind: "text", value: "TP-100-G", key: "tp-100-g" },
        { kind: "text", value: "Gießkanne 5 L", key: "gießkanne 5 l" },
        { kind: "text", value: "Garten > Gießen", key: "garten > gießen" },
        null,
      ],
    },
  ],
}

const GOLD: GoldProduct = {
  id: "P01",
  title: "Gießkanne 5 L",
  sourceRows: [1, 2],
  variants: [],
  photos: [],
  claims: ["robuster Stahlkörper"],
}

function grade(
  claims: Array<{
    text: string
    sourceRowIndex: number
    sourceColumn?: string
  }>,
  tags: string[] = []
) {
  return gradeProduct(RUN, GOLD, {
    title: "Gießkanne 5 Liter",
    category: "Garten > Gießen",
    tags,
    claims: claims ?? [],
  })
}

describe("loose token matching", () => {
  it("folds umlauts and drops stopwords", () => {
    expect(tokens("Gießen für und")).toEqual(["giessen"])
  })

  it("title: paraphrase passes, unrelated title fails", () => {
    expect(titleMatches("Gießkanne 5 Liter", "Gießkanne 5 L")).toBe(true)
    expect(titleMatches("Regentonne 100 L", "Gießkanne 5 L")).toBe(false)
  })

  it("category: containment and fuzzy overlap pass, wrong branch fails", () => {
    expect(categoryMatches("Garten > Gießen", "Garten > Gießen")).toBe(true)
    expect(categoryMatches("Gießen", "Garten > Gießen")).toBe(true)
    expect(categoryMatches("Wohnen > Sofas", "Garten > Gießen")).toBe(false)
  })
})

describe("claim traceability (EC-075)", () => {
  it("a grounded claim with a valid sourceRowIndex passes", () => {
    const result = grade([
      {
        text: "robuster Stahlkörper",
        sourceRowIndex: 1,
        sourceColumn: "Beschreibung",
      },
    ])
    expect(result.claims).toBe(true)
  })

  it("a claim citing a row outside sourceRows is an ERROR", () => {
    const result = grade([{ text: "robuster Stahlkörper", sourceRowIndex: 99 }])
    expect(result.claims).toBe(false)
    expect(result.failures.join(" ")).toMatch(/not in sourceRows/)
  })

  it("an invented claim (text not grounded in the cited row) is an ERROR", () => {
    const result = grade([{ text: "spülmaschinenfest", sourceRowIndex: 1 }])
    expect(result.claims).toBe(false)
  })

  it("a missed gold claim is an error; a covered one is not", () => {
    expect(
      grade([{ text: "robuster Stahlkörper", sourceRowIndex: 1 }]).claims
    ).toBe(true)
    expect(
      grade([{ text: "etwas ganz anderes", sourceRowIndex: 1 }]).claims
    ).toBe(false)
  })
})

describe("tag grounding", () => {
  it("tags traceable to source rows pass", () => {
    expect(grade([], ["Stahlkörper", "Gießkanne"]).tags).toBe(true)
  })

  it("invented tags are errors", () => {
    expect(grade([], ["Bambus"]).tags).toBe(false)
  })
})

describe("gold category derivation", () => {
  it("takes the majority Kategorie across source rows", () => {
    expect(goldCategory(RUN, [1, 2])).toBe("Garten > Gießen")
  })

  it("grounds text against exactly the cited row", () => {
    expect(sourceTextFor(RUN, [1, 2], 2)).not.toContain("Stahlkörper")
    expect(sourceTextFor(RUN, [1, 2], 1)).toContain("Stahlkörper")
  })
})

describe("sample selection", () => {
  it("prefers gold products with claims, then the rest, by id", () => {
    const gold: GoldProduct[] = [
      { id: "P03", title: "t", sourceRows: [], variants: [], photos: [] },
      {
        id: "P01",
        title: "t",
        sourceRows: [],
        variants: [],
        photos: [],
        claims: ["c"],
      },
      { id: "P02", title: "t", sourceRows: [], variants: [], photos: [] },
    ]
    expect(sampleProducts(gold).map((gp) => gp.id)).toEqual([
      "P01",
      "P02",
      "P03",
    ])
  })
})
