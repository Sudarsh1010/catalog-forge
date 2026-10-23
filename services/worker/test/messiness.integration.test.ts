/**
 * Messiness Score agreement test — the SQL fragment the match-media planner
 * executes and the TS `messinessScore` the enrich handler records MUST
 * agree on the shared (non-photo) terms, because the plan-time score stamps
 * the Job's routing_tier/provider_id (claim-gate/Pause metadata) while the
 * enrich-time score picks each enrich/translate call's model tier and
 * travels beside the enrichment. Both read the same weights
 * (`src/messiness.ts`); this test pins the agreement against real Postgres
 * so a drift in the fragment's SQL shape still fails loudly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"

import { planTimeMessinessSql, messinessScore } from "../src/messiness.js"
import { connectTestDb, createTestDatabase, dropTestDatabase } from "./helpers"

let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
})

beforeEach(async () => {
  await db.db.execute(
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files, products, variants CASCADE`
  )
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

interface Row {
  id: string
  identity_kind: string
  description: string | null
  category: string | null
  brand: string | null
  gtin: string | null
  ordinal: number
  messiness: number
}

async function seedProduct(
  importId: string,
  options: {
    identityKind?: "code" | "title"
    description?: string | null
    category?: string | null
    brand?: string | null
    gtin?: string | null
    variants?: Array<{ needsReview?: boolean }>
  } = {}
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO products (id, store_id, import_id, family_key, identity_kind,
                          natural_key, natural_key_hash, title, description,
                          category, brand, gtin)
    VALUES (${id}, 'default', ${importId},
            (SELECT family_key FROM imports WHERE id = ${importId}),
            ${options.identityKind ?? "code"},
            ${"sku:" + id.slice(0, 8)}, ${id}, 'Test ' || ${id.slice(0, 8)},
            ${options.description ?? "desc"}, ${options.category ?? "cat"},
            ${options.brand ?? "brand"}, ${options.gtin ?? "12345678"})
  `)
  for (const [i, variant] of (options.variants ?? []).entries()) {
    await db.db.execute(sql`
      INSERT INTO variants (store_id, import_id, product_id, variant_key,
                            variant_key_hash, source_row_index, needs_review)
      VALUES ('default', ${importId}, ${id}, ${"v" + i}, ${crypto.randomUUID()},
              ${i + 1}, ${variant.needsReview ?? false})
    `)
  }
  return id
}

describe("Messiness Score: SQL fragment and TS implementation agree", () => {
  it("scores plan-time products identically to messinessScore (photo-free)", async () => {
    const importId = crypto.randomUUID()
    await db.db.execute(sql`
      INSERT INTO imports (id, store_id, content_hash, family_key,
                           original_filename, sheet_format, sheet_object_key,
                           status, stage)
      VALUES (${importId}, 'default', ${crypto.randomUUID()}, 'sheet.csv',
              'sheet.csv', 'csv', 'k', 'running', 'group')
    `)
    await seedProduct(importId, { identityKind: "title", brand: null })
    await seedProduct(importId, {
      description: null,
      category: null,
      gtin: null,
      variants: [{ needsReview: true }, { needsReview: false }, {}, {}, {}],
    })
    await seedProduct(importId, { variants: [{}, {}, {}, {}, {}, {}] })

    const rows = (await db.db.execute(sql`
      SELECT s.id, s.identity_kind, s.description, s.category, s.brand, s.gtin,
             s.ordinal, ${planTimeMessinessSql()} AS messiness
      FROM (
        SELECT id, identity_kind, description, category, brand, gtin,
               ROW_NUMBER() OVER (ORDER BY natural_key_hash) AS ordinal
        FROM products WHERE import_id = ${importId}
      ) s
      ORDER BY s.ordinal
    `)) as unknown as Row[]

    expect(rows).toHaveLength(3)
    for (const row of rows) {
      const variantStats = (await db.db.execute(sql`
        SELECT count(*)::int AS n,
               bool_or(needs_review) AS any_review
        FROM variants WHERE product_id = ${row.id}
      `)) as unknown as Array<{ n: number; any_review: boolean }>
      const expected = messinessScore(
        {
          identityKind: row.identity_kind as "code" | "title",
          description: row.description,
          category: row.category,
          brand: row.brand,
          gtin: row.gtin,
        },
        variantStats[0]!.n,
        variantStats[0]!.any_review,
        0 // plan time: photos are not matched yet (see messiness.ts doc)
      )
      expect(row.messiness).toBe(expected)
    }
  })

  it("applies the photo term and the 100 cap only at enrich time", () => {
    const base = {
      identityKind: "code" as const,
      description: "d",
      category: "c",
      brand: "b",
      gtin: "1",
    }
    // Photos add points only in the enrich-time score…
    expect(messinessScore(base, 1, false, 3)).toBe(
      messinessScore(base, 1, false, 0) + 3 * 2
    )
    // …both per-variant and photo counts cap, and the total caps at 100.
    expect(messinessScore(base, 10, false, 0)).toBe(
      messinessScore(base, 4, false, 0)
    )
    expect(messinessScore(base, 1, false, 10)).toBe(
      messinessScore(base, 1, false, 3)
    )
    const maximal = {
      identityKind: "title" as const,
      description: null,
      category: null,
      brand: null,
      gtin: null,
    }
    expect(messinessScore(maximal, 99, true, 99)).toBe(100)
  })
})
