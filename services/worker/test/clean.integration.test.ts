/**
 * Clean Stage integration tests — the DB-contract seam.
 *
 * Tests seed domain facts (an Import in stage `clean` plus immutable raw
 * `sheet_rows`), run the real planner/handler/worker loops in-process, and
 * assert the cleaned projection, the Work Queue and the Redis event stream
 * through database state. No worker internals are mocked. Test names cite
 * the EC-### ids they pin from `edge-cases.md`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type {
  CleanColumnPlan,
  CleanedCell,
  CleanedFlag,
  SheetCell,
} from "@workspace/db/schema"

import { planCleanStage } from "../src/clean/plan.js"
import { createCleanHandler } from "../src/clean/handler.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedImport,
  waitFor,
} from "./helpers"
import { createWorker, defineHandlers, resolveConfig } from "../src/index.js"

let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

/** Insert raw sheet rows exactly as intake would land them. */
async function seedSheetRows(
  importId: string,
  rows: Array<Array<string | number | boolean | null>>
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await db.db.execute(sql`
      INSERT INTO sheet_rows (store_id, import_id, row_index, raw)
      VALUES ('test-store', ${importId}, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb)
    `)
  }
}

async function cleanJobRows(importId: string) {
  return (await db.db.execute(sql`
    SELECT batch_key, status FROM jobs
    WHERE import_id = ${importId} AND stage = 'clean'
    ORDER BY batch_key
  `)) as unknown as Array<{ batch_key: string; status: string }>
}

async function cleanPlanFor(importId: string) {
  const rows = (await db.db.execute(sql`
    SELECT columns FROM clean_plans WHERE import_id = ${importId}
  `)) as unknown as Array<{ columns: CleanColumnPlan[] }>
  return rows[0]?.columns ?? null
}

describe("clean stage planning (plan-then-execute, ADR-0002)", () => {
  it("plans every row-chunk Job up front with deterministic boundaries", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "clean",
      sheetHeader: ["SKU", "Name", "Price"],
    })
    // 7 rows: one chunk under the default constant chunk size.
    await seedSheetRows(imp.id, [
      ["SKU-1", "Blumentopf", "12.5"],
      ["SKU-2", "Käse", "1.299,00 €"],
      ["SKU-3", "Topf", "8"],
      ["SKU-4", "Tisch", "£8"],
      ["SKU-5", "Stuhl", ""],
      ["SKU-6", "Bank", "12,5"],
      ["SKU-7", "Regal", "1,299.00"],
    ])

    await planCleanStage(db.db, { importId: imp.id, storeId: imp.storeId })

    const jobs = await cleanJobRows(imp.id)
    expect(jobs).toEqual([
      { batch_key: "rows-000001-000007", status: "pending" },
    ])

    // The plan carries one entry per header column, in order.
    const plan = await cleanPlanFor(imp.id)
    expect(plan?.map((c) => [c.index, c.kind])).toEqual([
      [0, "text"],
      [1, "text"],
      [2, "price"],
    ])
  })

  it("chunks at a fixed constant size and re-plans to identical boundaries (determinism)", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "clean",
      sheetHeader: ["SKU", "Name"],
    })
    const rows = Array.from({ length: 10 }, (_, i) => [`SKU-${i + 1}`, "x"])
    await seedSheetRows(imp.id, rows)

    await planCleanStage(
      db.db,
      { importId: imp.id, storeId: imp.storeId },
      { chunkSize: 3 }
    )
    const first = await cleanJobRows(imp.id)

    // Re-planning (restart re-discovering its plan) must not drift or duplicate.
    await planCleanStage(
      db.db,
      { importId: imp.id, storeId: imp.storeId },
      { chunkSize: 3 }
    )
    const second = await cleanJobRows(imp.id)

    expect(first.map((j) => j.batch_key)).toEqual([
      "rows-000001-000003",
      "rows-000004-000006",
      "rows-000007-000009",
      "rows-000010-000010",
    ])
    expect(second).toEqual(first)
  })
})

/** Real claim-loop plumbing around the clean handler (no mocks). */
async function runCleanWorker(importId: string): Promise<void> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({ clean: createCleanHandler() }),
    config: resolveConfig({
      workerId: `w-clean-${importId.slice(0, 8)}`,
      claimIntervalMs: 10,
      heartbeatIntervalMs: 50,
      sweepIntervalMs: 25,
      leaseTtlMs: 2_000,
      batchSize: 10,
    }),
  })
  worker.start()
  try {
    await waitFor("clean chunk jobs completed", async () => {
      const rows = (await db.db.execute(sql`
        SELECT count(*)::int AS n FROM jobs
        WHERE import_id = ${importId} AND stage = 'clean' AND status <> 'completed'
      `)) as unknown as Array<{ n: number }>
      return (rows[0]?.n ?? 1) === 0
    })
  } finally {
    await worker.stop()
  }
}

async function cleanedProjection(importId: string) {
  return (await db.db.execute(sql`
    SELECT row_index, values, flags FROM cleaned_rows
    WHERE import_id = ${importId}
    ORDER BY row_index
  `)) as unknown as Array<{
    row_index: number
    values: unknown[]
    flags: unknown[]
  }>
}

describe("clean chunk handler (idempotent upserts, ADR-0003)", () => {
  it("cleans a chunk into the typed projection; re-running the chunk converges with zero duplicates", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "clean",
      sheetHeader: ["SKU", "Name", "Description", "Price"],
    })
    await seedSheetRows(imp.id, [
      [
        "SKU-1",
        "KÃ¤se",
        "<p>Winterfest</p><script>alert(1)</script>",
        "1.299,00 €",
      ],
      ["SKU-2", "GrÃ¶ÃŸe", '=HYPERLINK("http://evil","click")', "12,5"],
    ])
    await planCleanStage(db.db, { importId: imp.id, storeId: imp.storeId })

    await runCleanWorker(imp.id)

    const first = await cleanedProjection(imp.id)
    expect(first).toHaveLength(2)

    const [row1, row2] = first as Array<{
      row_index: number
      values: Array<Record<string, unknown> | null>
      flags: Array<Record<string, unknown>>
    }>

    // EC-002: mojibake repaired where recoverable.
    expect(row1?.values?.[1]).toMatchObject({ kind: "text", value: "Käse" })
    // EC-056: unsafe script stripped, benign markup preserved.
    expect(row1?.values?.[2]).toMatchObject({
      kind: "html",
      value: "<p>Winterfest</p>",
    })
    // EC-021: de price through string math — 1299.00 → 129900 cents.
    expect(row1?.values?.[3]).toMatchObject({
      kind: "price",
      cents: 129900,
      currency: "EUR",
    })

    // EC-022: formula cell neutralized, raw preserved in the flag trail.
    expect(row2?.values?.[2]).toMatchObject({
      kind: "text",
      value: '\'=HYPERLINK("http://evil","click")',
    })
    expect(row2?.values?.[3]).toMatchObject({
      kind: "price",
      cents: 1250,
      currency: "EUR",
    })
    expect(row2?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ ec: "EC-022" })])
    )

    // Idempotency (ADR-0003): redeliver the same Job — the projection must
    // converge byte-identically, never duplicate rows.
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE import_id = ${imp.id} AND stage = 'clean'
    `)
    await runCleanWorker(imp.id)

    const second = await cleanedProjection(imp.id)
    expect(second).toEqual(first)
    const counts = (await db.db.execute(sql`
      SELECT count(*)::int AS n, count(DISTINCT row_index)::int AS distinct_n
      FROM cleaned_rows WHERE import_id = ${imp.id}
    `)) as unknown as Array<{ n: number; distinct_n: number }>
    expect(counts[0]).toEqual({ n: 2, distinct_n: 2 })
  })
})

/** Plan + run one chunk, return the cleaned rows (values + flags) in order. */
async function cleanOnce(
  header: string[],
  rows: SheetCell[][]
): Promise<
  Array<{ values: Array<CleanedCell | null>; flags: Array<CleanedFlag> }>
> {
  const imp = await seedImport(db, {
    status: "running",
    stage: "clean",
    sheetHeader: header,
  })
  await seedSheetRows(imp.id, rows)
  await planCleanStage(db.db, { importId: imp.id, storeId: imp.storeId })
  await runCleanWorker(imp.id)
  const projection = await cleanedProjection(imp.id)
  return projection as Array<{
    values: Array<CleanedCell | null>
    flags: Array<CleanedFlag>
  }>
}

describe("price normalization (EC-038/EC-039/EC-040)", () => {
  it("golden prices_de: every §5 format in one column with known-good parsed values", async () => {
    const rows = await cleanOnce(
      ["Preis"],
      [
        ["1.299,00 €"], // de thousands+decimals with symbol → 1299.00 EUR
        ["2.480,50 €"], // de, keeps the symbol majority clearly EUR
        ["1,299.00"], // en format, self-proven
        ["12.5"], // one decimal digit → unambiguous en
        ["£8"], // foreign symbol in a mostly-EUR column
        [""], // blank → missing, no invention
        [null], // absent → missing
        ["1.299"], // ambiguous: resolved by the column vote (de majority)
        ["12,5"], // unambiguous de
        ["1.234.567,89"], // de grouping, self-proven
        ["1 234 567,89"], // NBSP grouping (French typography), self-proven
      ]
    )
    const values = rows.map((r) => r.values[0])
    expect(values[0]).toEqual({ kind: "price", cents: 129900, currency: "EUR" })
    expect(values[1]).toEqual({ kind: "price", cents: 248050, currency: "EUR" })
    expect(values[2]).toEqual({ kind: "price", cents: 129900, currency: "EUR" })
    expect(values[3]).toEqual({ kind: "price", cents: 1250, currency: "EUR" })
    expect(values[4]).toEqual({ kind: "price", cents: 800, currency: "GBP" })
    expect(values[5]).toBeNull()
    expect(values[6]).toBeNull()
    // Column vote: de proofs (rows 1, 2, 9) outnumber en proofs (rows 3, 4)
    // → `1.299` reads as de grouping = 1299.00.
    expect(values[7]).toEqual({ kind: "price", cents: 129900, currency: "EUR" })
    expect(values[8]).toEqual({ kind: "price", cents: 1250, currency: "EUR" })
    expect(values[9]).toEqual({
      kind: "price",
      cents: 123456789,
      currency: "EUR",
    })
    expect(values[10]).toEqual({
      kind: "price",
      cents: 123456789,
      currency: "EUR",
    })
    // EC-039: the en-format intruder parses by its own convention, flagged.
    expect(rows[2]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-039", code: "price_format_mixed" }),
      ])
    )
    // EC-040: `£8` inside a mostly-EUR column is parsed as GBP but flagged.
    expect(rows[4]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-040", code: "price_currency_mixed" }),
      ])
    )
    // Observing €/£ symbols means no currency assumption was made.
    expect(rows[0]?.flags).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "price_currency_assumed" }),
      ])
    )
  })

  it("flags a locale-ambiguous column (EC-038) instead of guessing", async () => {
    // 1 de vote vs 1 en vote — a tie decides nothing; `1.299`/`1,234` stay unparsed.
    const rows = await cleanOnce(
      ["Preis"],
      [
        ["1.299"],
        ["1,234"],
        ["12,5"], // de proof
        ["12.5"], // en proof — tie
      ]
    )
    expect(rows[0]?.values[0]).toEqual({ kind: "unparseable", value: "1.299" })
    expect(rows[1]?.values[0]).toEqual({ kind: "unparseable", value: "1,234" })
    expect(rows[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ec: "EC-038",
          code: "price_locale_ambiguous",
        }),
      ])
    )
    // Self-proven values still parse regardless of the tie.
    expect(rows[2]?.values[0]).toEqual({
      kind: "price",
      cents: 1250,
      currency: "EUR",
    })
    expect(rows[3]?.values[0]).toEqual({
      kind: "price",
      cents: 1250,
      currency: "EUR",
    })
  })

  it("flags minority formats in a mixed column (EC-039) while parsing them by their own convention", async () => {
    const rows = await cleanOnce(
      ["Price (EUR)"],
      [
        ["1.299,00"],
        ["2.480,50"],
        ["3,5"], // de proof
        ["4,5"], // de proof
        ["1,299.00"], // en intruder (supplier merged two sources)
      ]
    )
    // de majority wins the column; the en cell self-disambiguates and parses
    // correctly but is flagged as a mixed-format row.
    expect(rows[4]?.values[0]).toEqual({
      kind: "price",
      cents: 129900,
      currency: "EUR",
    })
    expect(rows[4]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-039", code: "price_format_mixed" }),
      ])
    )
    expect(rows[0]?.flags).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "price_format_mixed" }),
      ])
    )
  })

  it("assumes the store currency when a column carries none and notes it (EC-040)", async () => {
    const rows = await cleanOnce(["Preis"], [["129,90"], ["99"]])
    expect(rows[0]?.values[0]).toEqual({
      kind: "price",
      cents: 12990,
      currency: "EUR",
    })
    expect(rows[1]?.values[0]).toEqual({
      kind: "price",
      cents: 9900,
      currency: "EUR",
    })
    expect(rows[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ec: "EC-040",
          code: "price_currency_assumed",
        }),
      ])
    )
  })

  it("flags a bare $ as an ambiguous currency symbol (EC-040)", async () => {
    const rows = await cleanOnce(["Price"], [["$12.50"]])
    expect(rows[0]?.values[0]).toEqual({
      kind: "price",
      cents: 1250,
      currency: "USD",
    })
    expect(rows[0]?.flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ ec: "EC-040" })])
    )
  })

  it("flags negative prices (EC-043) and rounds sub-cent thirds (EC-045)", async () => {
    const rows = await cleanOnce(["Preis"], [["-5,00"], ["1,999"]])
    expect(rows[0]?.values[0]).toEqual({
      kind: "price",
      cents: -500,
      currency: "EUR",
    })
    expect(rows[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-043", code: "price_negative" }),
      ])
    )
    // 1,999 de = 1.999 → 199.9 cents → rounds half-up to 200 with a trail.
    expect(rows[1]?.values[0]).toEqual({
      kind: "price",
      cents: 200,
      currency: "EUR",
    })
    expect(rows[1]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-045", code: "price_rounded" }),
      ])
    )
  })
})

describe("unit normalization (EC-047/EC-048/EC-049, EC-026)", () => {
  it("converts cm/inch and kg/lb/oz families to canonical metric integers with one half-up rounding", async () => {
    const rows = await cleanOnce(
      ["Länge (cm)", "Durchmesser", "Gewicht", "Volumen (l)"],
      [
        // Länge: header unit for the bare cell, cell unit when present.
        ["50", 'Ø 19.6"', "1,5 kg", "1,5"],
        ["ca. 50 cm", "50 cm", "2 lb", "32 fl oz"],
        ["0,5 m", "50-60 cm", "16 oz", "750"],
        [null, "50 x 30 x 20", "500", null],
      ]
    )

    // 50 → 500 mm (EC-026: unit from header, noted); 0,5 m → 500 mm (de vote).
    expect(rows[0]?.values[0]).toEqual({
      kind: "quantity",
      value: 500,
      unit: "mm",
      original: "50",
    })
    expect(rows[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ec: "EC-026",
          code: "quantity_unit_from_header",
        }),
      ])
    )
    expect(rows[2]?.values[0]).toEqual({
      kind: "quantity",
      value: 500,
      unit: "mm",
      original: "0,5 m",
    })
    expect(rows[1]?.values[0]).toEqual({
      kind: "quantity",
      value: 500,
      unit: "mm",
      original: "ca. 50 cm",
    })

    // EC-047: 19.6" → 497.84 mm → 498 mm (no false precision).
    expect(rows[0]?.values[1]).toEqual({
      kind: "quantity",
      value: 498,
      unit: "mm",
      original: 'Ø 19.6"',
    })
    expect(rows[1]?.values[1]).toEqual({
      kind: "quantity",
      value: 500,
      unit: "mm",
      original: "50 cm",
    })
    // EC-048: ranges and dimension lists are garbage here — flagged, raw kept.
    expect(rows[2]?.values[1]).toEqual({
      kind: "unparseable",
      value: "50-60 cm",
    })
    expect(rows[2]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-048", code: "quantity_unparseable" }),
      ])
    )
    expect(rows[3]?.values[1]).toEqual({
      kind: "unparseable",
      value: "50 x 30 x 20",
    })

    // Weight: 1,5 kg (de vote) → 1500 g; 2 lb → 907 g; 16 oz → 454 g.
    expect(rows[0]?.values[2]).toEqual({
      kind: "quantity",
      value: 1500,
      unit: "g",
      original: "1,5 kg",
    })
    expect(rows[1]?.values[2]).toEqual({
      kind: "quantity",
      value: 907,
      unit: "g",
      original: "2 lb",
    })
    expect(rows[2]?.values[2]).toEqual({
      kind: "quantity",
      value: 454,
      unit: "g",
      original: "16 oz",
    })
    // 500 in a column with no unit anywhere → unconvertible, flagged (EC-026).
    expect(rows[3]?.values[2]).toEqual({ kind: "unparseable", value: "500" })
    expect(rows[3]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ec: "EC-026",
          code: "quantity_unit_missing",
        }),
      ])
    )

    // Volume: 1,5 l → 1500 ml; 32 fl oz → 946 ml; 750 (header l) → 750000 ml.
    expect(rows[0]?.values[3]).toEqual({
      kind: "quantity",
      value: 1500,
      unit: "ml",
      original: "1,5",
    })
    expect(rows[1]?.values[3]).toEqual({
      kind: "quantity",
      value: 946,
      unit: "ml",
      original: "32 fl oz",
    })
    expect(rows[2]?.values[3]).toEqual({
      kind: "quantity",
      value: 750000,
      unit: "ml",
      original: "750",
    })
  })
})

describe("encoding repair and key normalization (EC-002/EC-020/EC-053/EC-057)", () => {
  it("repairs mojibake, preserves display originals, folds keys to NFC+ASCII base forms", async () => {
    const nfdName = "Ka\u0308se" // NFD decomposition — macOS exports (EC-053)
    const rows = await cleanOnce(
      ["Name", "Beschreibung"],
      [
        ["KÃ¤se", "Wanduhr “premium”"], // mojibake + AutoCorrect smart quotes
        [nfdName, "top\u200b\u00ad grade"], // NFD + zero-width + soft hyphen
        ["K\uFFFDse", "<p>a <b>bold</b> &amp; mehr</p><o:p>junk</o:p>"],
      ]
    )

    // EC-002: repair applied, flag carries provenance.
    expect(rows[0]?.values[0]).toMatchObject({ kind: "text", value: "Käse" })
    expect(rows[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-002", code: "encoding_repaired" }),
      ])
    )
    // EC-053: display keeps the supplier's NFD form; the key is NFC.
    expect(rows[1]?.values[0]).toMatchObject({ kind: "text", value: nfdName })
    expect(rows[1]?.values[0]).toMatchObject({ kind: "text", key: "käse" })
    // Both spellings land on the same matching key.
    expect(rows[0]?.values[0]).toMatchObject({ kind: "text", key: "käse" })
    // EC-020: smart quotes fold in the key, display keeps them.
    expect(rows[0]?.values[1]).toMatchObject({
      kind: "text",
      value: "Wanduhr “premium”",
      key: 'wanduhr "premium"',
    })
    // EC-057: zero-width/soft-hyphen stripped, flagged; key collapses spaces.
    expect(rows[1]?.values[1]).toMatchObject({
      kind: "text",
      value: "top grade",
      key: "top grade",
    })
    expect(rows[1]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ec: "EC-057",
          code: "invisible_chars_stripped",
        }),
      ])
    )
    // EC-002: U+FFFD is already-destroyed data — flagged unrecoverable, kept.
    expect(rows[2]?.values[0]).toMatchObject({
      kind: "text",
      value: "K\uFFFDse",
    })
    expect(rows[2]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ec: "EC-002",
          code: "encoding_unrecoverable",
        }),
      ])
    )
    // EC-056: benign markup survives, Word junk tag stripped, entity kept.
    expect(rows[2]?.values[1]).toEqual({
      kind: "html",
      value: "<p>a <b>bold</b> &amp; mehr</p>junk",
    })
    expect(rows[2]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ec: "EC-056", code: "html_sanitized" }),
      ])
    )
  })

  it("strips scripts, event handlers and unsafe embeds while balancing benign markup", async () => {
    const rows = await cleanOnce(
      ["Beschreibung"],
      [
        ["<p>ok</p><script>alert(1)</script>"],
        ['<b onclick="steal()">hi</b><br/>'],
        ["<p>unclosed"],
        ['<iframe src="http://evil"></iframe>plain'],
        ["a < b and 5>3"], // no markup: stays text
      ]
    )
    expect(rows[0]?.values[0]).toEqual({ kind: "html", value: "<p>ok</p>" })
    expect(rows[1]?.values[0]).toEqual({
      kind: "html",
      value: "<b>hi</b><br/>",
    })
    expect(rows[2]?.values[0]).toEqual({
      kind: "html",
      value: "<p>unclosed</p>",
    })
    expect(rows[3]?.values[0]).toEqual({ kind: "html", value: "plain" })
    expect(rows[4]?.values[0]).toMatchObject({
      kind: "text",
      value: "a < b and 5>3",
    })
    // Every sanitized row carries the EC-056 trail; the plain text row does not.
    for (const index of [0, 1, 2, 3]) {
      expect(rows[index]?.flags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ec: "EC-056", code: "html_sanitized" }),
        ])
      )
    }
    expect(rows[4]?.flags).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "html_sanitized" }),
      ])
    )
  })
})
