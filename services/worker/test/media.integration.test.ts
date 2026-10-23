/**
 * match-media Stage integration tests — the DB-contract seam.
 *
 * Tests run the real pipeline in-process (adoption → intake → clean → group
 * barrier → match-media) against live Postgres, Redis and object storage,
 * then assert Product/Variant photo links and Parked Photos through database
 * state. No worker internals are mocked. Test names cite the EC-### ids they
 * pin from `edge-cases.md`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"

import { createIntakeHandler } from "../src/intake.js"
import { createCleanHandler } from "../src/clean/handler.js"
import { createGroupHandler } from "../src/group/handler.js"
import { createMatchMediaHandler } from "../src/media/handler.js"
import {
  createWorker,
  defineHandlers,
  type WorkerHandle,
} from "../src/index.js"
import { planCleanStage } from "../src/clean/plan.js"
import { planGroupStage } from "../src/group/plan.js"
import { planMatchMediaStage } from "../src/media/plan.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  putTestObject,
  seedImport,
  seedImportFile,
  testCache,
  testStorage,
  waitFor,
} from "./helpers"
import { buildZip, csvBytes, PNG_BYTES } from "./fixtures"

let db: Db
let storage: Storage
let cache: Cache

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  storage = testStorage()
  cache = testCache()
})

beforeEach(async () => {
  // CASCADE covers the FK-referencing projections (clean_plans, products, …).
  await db.db.execute(
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files CASCADE`
  )
})

afterAll(async () => {
  await cache.close()
  await db.close()
  await dropTestDatabase()
})

const SHEET_HEADER = ["SKU", "Title", "Price", "EAN", "Farbe"]
const SHEET_ROWS = [
  ["TP-100-R", "Gießkanne 5L", "12,50", "", "rot"],
  ["TP-100-G", "Gießkanne 5L", "12,50", "", "grün"],
  ["TP-101", "Schaufel", "4,90", "", ""],
  ["GE-01", "Gartenempo", "7,00", "4006381333931", ""],
]

/** Seed a queued Import with the sheet and four photos in storage. */
async function seedUpload(): Promise<{ id: string; storeId: string }> {
  const imp = await seedImport(db, { sheetHeader: SHEET_HEADER })
  await putTestObject(
    storage,
    imp.sheetObjectKey,
    csvBytes([SHEET_HEADER, ...SHEET_ROWS]),
    "text/csv"
  )

  // Loose uploads: exact-SKU filename, title filename, camera original.
  const loose: Array<[string, string]> = [
    ["tp-100-g-01.jpg", "photos/tp-100-g-01.jpg"],
    ["Gartenempo.png", "photos/Gartenempo.png"],
    ["IMG_4472.JPG", "photos/IMG_4472.JPG"],
  ]
  for (const [filename, keySuffix] of loose) {
    const objectKey = `t4-tests/${imp.id}/${keySuffix}`
    await putTestObject(storage, objectKey, PNG_BYTES, "image/png")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo",
      objectKey,
      filename,
      contentType: "image/png",
    })
  }

  // Archive: the subfolder-hint photo (SKU in the folder, camera base name).
  const zip = await buildZip([
    { name: "bilder/tp-101/IMG_0007.png", data: PNG_BYTES },
  ])
  const archiveKey = `t4-tests/${imp.id}/photos.zip`
  await putTestObject(storage, archiveKey, zip, "application/zip")
  await seedImportFile(db, {
    importId: imp.id,
    kind: "photo_zip",
    objectKey: archiveKey,
    filename: "photos.zip",
  })
  return imp
}

/** Real pipeline through the media Stage; resolves after the media Job. */
async function runPipelineThroughMedia(
  importId: string
): Promise<WorkerHandle> {
  const worker = createWorker({
    db,
    handlers: defineHandlers({
      intake: createIntakeHandler({ storage, cache }),
      clean: createCleanHandler(),
      group: createGroupHandler(),
      "match-media": createMatchMediaHandler(),
    }),
    cache,
    config: {
      workerId: `w-media-${crypto.randomUUID().slice(0, 8)}`,
      claimIntervalMs: 10,
      heartbeatIntervalMs: 50,
      sweepIntervalMs: 25,
      leaseTtlMs: 2_000,
      batchSize: 10,
    },
    planners: {
      clean: planCleanStage,
      group: planGroupStage,
      "match-media": planMatchMediaStage,
    },
  })
  worker.start()
  await waitForMediaDone(importId)
  await worker.stop()
  return worker
}

async function waitForMediaDone(importId: string): Promise<void> {
  await waitFor(
    "match-media job completed",
    async () => {
      const rows = (await db.db.execute(sql`
        SELECT status FROM jobs
        WHERE import_id = ${importId} AND stage = 'match-media'
      `)) as unknown as Array<{ status: string }>
      return rows.length === 1 && rows[0]!.status === "completed"
    },
    15_000
  )
}

interface MatchRow {
  filename: string
  natural_key: string
  variant_sku: string | null
  matched_via: string
  matched_token: string
}

async function matchRows(importId: string): Promise<MatchRow[]> {
  return (await db.db.execute(sql`
    SELECT f.filename, p.natural_key, v.sku AS variant_sku,
           pp.matched_via, pp.matched_token
    FROM product_photos pp
    JOIN import_files f ON f.id = pp.import_file_id
    JOIN products p ON p.id = pp.product_id
    LEFT JOIN variants v ON v.id = pp.variant_id
    WHERE pp.import_id = ${importId}
    ORDER BY f.filename
  `)) as unknown as MatchRow[]
}

async function parkedRows(
  importId: string
): Promise<Array<{ filename: string; reason: string; ec: string | null }>> {
  return (await db.db.execute(sql`
    SELECT f.filename, pk.reason, pk.ec
    FROM parked_photos pk
    JOIN import_files f ON f.id = pk.import_file_id
    WHERE pk.import_id = ${importId}
    ORDER BY f.filename
  `)) as unknown as Array<{
    filename: string
    reason: string
    ec: string | null
  }>
}

describe("photo matching by ranked strategies (EC-072)", () => {
  it("matches by exact SKU in the filename, then title, then subfolder hint — and parks the rest with a reason", async () => {
    const imp = await seedUpload()
    await runPipelineThroughMedia(imp.id)

    const matches = await matchRows(imp.id)
    expect(matches).toEqual([
      {
        // Strategy 2: normalized title of the base name equals the Product title.
        filename: "Gartenempo.png",
        natural_key: "sku:ge-01",
        variant_sku: null,
        matched_via: "title",
        matched_token: "gartenempo",
      },
      {
        // Strategy 3: SKU token in a subfolder segment of the entry path.
        filename: "bilder/tp-101/IMG_0007.png",
        natural_key: "sku:tp-101",
        variant_sku: "TP-101",
        matched_via: "subfolder",
        matched_token: "tp-101",
      },
      {
        // Strategy 1: exact SKU token in the base name; pins the Variant.
        filename: "tp-100-g-01.jpg",
        natural_key: "sku:tp-100",
        variant_sku: "TP-100-G",
        matched_via: "sku",
        matched_token: "tp-100-g",
      },
    ])

    // The camera original matched nothing: parked, never silently dropped.
    const parked = await parkedRows(imp.id)
    expect(parked).toHaveLength(1)
    expect(parked[0]!.filename).toBe("IMG_4472.JPG")
    expect(parked[0]!.ec).toBe("EC-072")
    expect(parked[0]!.reason).toMatch(/no .* matched/i)
  })

  it("matches a GTIN token in the filename across UPC/EAN widths (EC-036, EC-072)", async () => {
    const imp = await seedUpload()
    await runPipelineThroughMedia(imp.id)

    // GE-01 carries EAN 4006381333931; the zero-padded GTIN-14 form in the
    // filename must hit the same Variant (width tolerance, EC-036).
    await db.db.execute(sql`
      INSERT INTO import_files (store_id, import_id, kind, object_key, filename, content_type, sha256)
      VALUES ('test-store', ${imp.id}, 'photo', 't4-tests/gtin/extra.png', '04006381333931.png', 'image/png', 'manual')
    `)
    // Re-run the media Job with the extra photo present.
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0
      WHERE import_id = ${imp.id} AND stage = 'match-media'
    `)
    const worker = createWorker({
      db,
      handlers: defineHandlers({ "match-media": createMatchMediaHandler() }),
      config: {
        workerId: `w-media-${crypto.randomUUID().slice(0, 8)}`,
        claimIntervalMs: 10,
      },
    })
    worker.start()
    try {
      await waitFor("media re-run completed", async () => {
        const rows = (await db.db.execute(sql`
          SELECT status FROM jobs WHERE import_id = ${imp.id} AND stage = 'match-media'
        `)) as unknown as Array<{ status: string }>
        return rows[0]?.status === "completed"
      })
    } finally {
      await worker.stop()
    }

    const gtinMatch = (await matchRows(imp.id)).find(
      (row) => row.filename === "04006381333931.png"
    )
    expect(gtinMatch).toMatchObject({
      natural_key: "sku:ge-01",
      matched_via: "gtin",
    })
  })

  it("re-running the media Job converges on the identical assignment (ADR-0003)", async () => {
    const imp = await seedUpload()
    await runPipelineThroughMedia(imp.id)
    const first = await matchRows(imp.id)
    const parkedFirst = await parkedRows(imp.id)

    // Redeliver: crash-after-write shape — the handler recomputes and
    // reconciles to exactly the same rows, zero duplicates.
    await db.db.execute(sql`
      UPDATE jobs SET status = 'pending', attempts = 0
      WHERE import_id = ${imp.id} AND stage = 'match-media'
    `)
    await runPipelineThroughMedia(imp.id)

    expect(await matchRows(imp.id)).toEqual(first)
    expect(await parkedRows(imp.id)).toEqual(parkedFirst)
    const counts = (await db.db.execute(sql`
      SELECT (SELECT count(*)::int FROM product_photos WHERE import_id = ${imp.id}) AS matched,
             (SELECT count(*)::int FROM parked_photos WHERE import_id = ${imp.id}) AS parked
    `)) as unknown as Array<{ matched: number; parked: number }>
    expect(counts[0]).toEqual({ matched: 3, parked: 1 })
  })
})
