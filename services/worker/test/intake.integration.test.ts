/**
 * Intake Stage — DB-contract seam.
 *
 * Tests seed an Import plus fixture files in object storage, run the Worker's
 * real loops in-process (adoption → claim → intake), and assert observable
 * Postgres rows and the Redis event stream. Worker internals are never
 * mocked; failure-class tests reference the edge-case ids they prove handled.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { importStreamKey, type ImportEvent } from "@workspace/pipeline"

import { createIntakeHandler } from "../src/intake.js"
import { createWorker, type WorkerHandle } from "../src/index.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  flushTestRedis,
  getTestObject,
  putTestObject,
  seedImport,
  seedImportFile,
  testCache,
  testStorage,
  waitFor,
} from "./helpers"
import {
  buildXlsx,
  buildZip,
  csvBytes,
  patchZipEntryName,
  PNG_BYTES,
  truncate,
} from "./fixtures"

let db: Db
let storage: Storage
let cache: Cache

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  storage = testStorage()
  cache = testCache()
  await flushTestRedis()
})

beforeEach(async () => {
  await db.db.execute(
    sql`TRUNCATE translation_memory, jobs, imports, sheet_rows, import_files, cleaned_rows, clean_plans CASCADE`
  )
})

afterAll(async () => {
  await db.close()
  await flushTestRedis()
  await dropTestDatabase()
})

/** Fast real loops: claim/sweep within milliseconds, TTL 2s. */
function startWorker(overrides?: {
  maxSheetRows?: number
  maxZipTotalUncompressedBytes?: number
  maxZipEntryBytes?: number
}): WorkerHandle {
  const handler = createIntakeHandler({
    storage,
    cache,
    limits: {
      maxSheetRows: overrides?.maxSheetRows,
      maxZipTotalUncompressedBytes: overrides?.maxZipTotalUncompressedBytes,
      maxZipEntryBytes: overrides?.maxZipEntryBytes,
    },
  })
  const worker = createWorker({
    db,
    handlers: { intake: handler },
    cache,
    config: {
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      heartbeatIntervalMs: 100,
      leaseTtlMs: 2_000,
      batchSize: 10,
    },
  })
  worker.start()
  return worker
}

interface ImportRow {
  status: string
  stage: string
  row_count: number | null
  failure_reason: string | null
  sheet_header: string[] | null
}

async function importRow(importId: string): Promise<ImportRow> {
  const rows = (await db.db.execute(sql`
    SELECT status, stage, row_count, failure_reason, sheet_header
    FROM imports WHERE id = ${importId}
  `)) as unknown as ImportRow[]
  return rows[0]!
}

interface SheetRowRecord {
  row_index: number
  raw: unknown[]
}

async function sheetRows(importId: string): Promise<SheetRowRecord[]> {
  return (await db.db.execute(sql`
    SELECT row_index, raw FROM sheet_rows
    WHERE import_id = ${importId} ORDER BY row_index
  `)) as unknown as SheetRowRecord[]
}

interface FileRow {
  kind: string
  object_key: string
  filename: string
  sha256: string | null
  size_bytes: string | null
}

async function fileRows(importId: string): Promise<FileRow[]> {
  return (await db.db.execute(sql`
    SELECT kind, object_key, filename, sha256, size_bytes FROM import_files
    WHERE import_id = ${importId} ORDER BY created_at, id
  `)) as unknown as FileRow[]
}

interface StreamEntry {
  id: string
  event: ImportEvent
}

async function readEvents(importId: string): Promise<StreamEntry[]> {
  const entries = (await cache.redis.xrange(
    importStreamKey(importId),
    "-",
    "+"
  )) as Array<[string, string[]]>
  return entries.map(([id, fields]) => {
    const flat = new Map<string, string>()
    for (let i = 0; i < fields.length; i += 2) {
      flat.set(fields[i]!, fields[i + 1]!)
    }
    return { id, event: JSON.parse(flat.get("data")!) as ImportEvent }
  })
}

const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex")

// ------------------------------------------------------------------ tests --

describe("intake lands raw sheet rows (CSV)", () => {
  it("lands rows exactly as sent — quotes, embedded commas and newlines intact", async () => {
    const csv = csvBytes([
      ["sku", "name", "price", "note"],
      [
        "TP-100",
        "Blumentopf, terracotta",
        "12,99 €",
        "bring indoors\nbelow 0 °C",
      ],
      ["TP-101", "Wanduhr", "", 'note with "quotes" inside'],
      ["TP-102", "Vase", "8,50 €", ""],
    ])
    const imp = await seedImport(db)
    await putTestObject(storage, imp.sheetObjectKey, csv, "text/csv")

    const worker = startWorker()
    try {
      await waitFor("import advanced to clean", async () => {
        const row = await importRow(imp.id)
        return row.stage === "clean" && row.status === "running"
      })

      const row = await importRow(imp.id)
      expect(row.row_count).toBe(3)
      expect(row.sheet_header).toEqual(["sku", "name", "price", "note"])
      expect(row.failure_reason).toBeNull()

      const rows = await sheetRows(imp.id)
      expect(rows).toHaveLength(3)
      expect(rows[0]!.raw).toEqual([
        "TP-100",
        "Blumentopf, terracotta",
        "12,99 €",
        "bring indoors\nbelow 0 °C",
      ])
      expect(rows[1]!.raw).toEqual([
        "TP-101",
        "Wanduhr",
        "",
        'note with "quotes" inside',
      ])
      expect(rows[2]!.row_index).toBe(3)
    } finally {
      await worker.stop()
    }
  })

  it("publishes stage_changed then job_completed on the capped import stream", async () => {
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku"], ["TP-100"]])
    )

    const worker = startWorker()
    try {
      await waitFor("job completed event", async () => {
        const events = await readEvents(imp.id)
        return events.some((e) => e.event.type === "job_completed")
      })

      const events = await readEvents(imp.id)
      const types = events.map((e) => e.event.type)
      expect(types).toContain("stage_changed")
      expect(types).toContain("job_completed")
      expect(types.indexOf("stage_changed")).toBeLessThan(
        types.indexOf("job_completed")
      )
      const stageChanged = events.find((e) => e.event.type === "stage_changed")!
      expect(stageChanged.event.data).toMatchObject({
        importId: imp.id,
        from: "intake",
        to: "clean",
      })
      const jobCompleted = events.find((e) => e.event.type === "job_completed")!
      expect(jobCompleted.event.data).toMatchObject({
        importId: imp.id,
        stage: "intake",
      })
    } finally {
      await worker.stop()
    }
  })

  it("handles a 2,000-row sheet in batches", async () => {
    const rows: string[][] = [["sku", "name"]]
    for (let i = 1; i <= 2_000; i++) rows.push([`SKU-${i}`, `Product ${i}`])
    const imp = await seedImport(db)
    await putTestObject(storage, imp.sheetObjectKey, csvBytes(rows))

    const worker = startWorker()
    try {
      await waitFor("2000 rows landed", async () => {
        const row = await importRow(imp.id)
        return row.row_count === 2_000
      })
      const landed = await sheetRows(imp.id)
      expect(landed).toHaveLength(2_000)
      expect(landed[1999]!.raw).toEqual(["SKU-2000", "Product 2000"])
    } finally {
      await worker.stop()
    }
  })

  it("hashes loose photos uploaded with the sheet", async () => {
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku"], ["TP-100"]])
    )
    const photoKey = `t2-tests/${imp.id}/photos/IMG_4472.JPG`
    await putTestObject(storage, photoKey, PNG_BYTES, "image/png")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo",
      objectKey: photoKey,
      filename: "IMG_4472.JPG",
      contentType: "image/png",
    })

    const worker = startWorker()
    try {
      await waitFor("photo hashed", async () => {
        const files = await fileRows(imp.id)
        return files.some((f) => f.sha256 !== null)
      })
      const files = await fileRows(imp.id)
      expect(files[0]!.sha256).toBe(sha256(PNG_BYTES))
    } finally {
      await worker.stop()
    }
  })
})

describe("intake parses XLSX workbooks", () => {
  it("lands typed cells from a real workbook and picks the non-empty sheet", async () => {
    const bytes = await buildXlsx([
      { name: "Tabelle1", rows: [["sku"]] },
      {
        name: "Daten",
        rows: [
          ["sku", "name", "price", "in_stock"],
          ["TP-100", "Blumentopf", 12.99, true],
          ["TP-101", "Vase", 8.5, false],
        ],
      },
    ])
    const imp = await seedImport(db, {
      sheetFormat: "xlsx",
      originalFilename: "sheet.xlsx",
    })
    await putTestObject(storage, imp.sheetObjectKey, bytes)

    const worker = startWorker()
    try {
      await waitFor("xlsx import advanced", async () => {
        const row = await importRow(imp.id)
        return row.stage === "clean"
      })
      const row = await importRow(imp.id)
      expect(row.row_count).toBe(2)
      expect(row.sheet_header).toEqual(["sku", "name", "price", "in_stock"])
      const rows = await sheetRows(imp.id)
      expect(rows[0]!.raw).toEqual(["TP-100", "Blumentopf", 12.99, true])
      expect(rows[1]!.raw).toEqual(["TP-101", "Vase", 8.5, false])
    } finally {
      await worker.stop()
    }
  })
})

describe("intake photo archives (ZIP)", () => {
  it("extracts entries, hashes them, and re-uploads them by hash", async () => {
    const zip = await buildZip([
      { name: "photos/red.png", data: PNG_BYTES },
      { name: "__MACOSX/photos/._red.png", data: "junk" },
      { name: "photos/blue.png", data: Buffer.from("blue-bytes") },
    ])
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku"], ["TP-100"]])
    )
    const archiveKey = `t2-tests/${imp.id}/photos.zip`
    await putTestObject(storage, archiveKey, zip, "application/zip")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo_zip",
      objectKey: archiveKey,
      filename: "photos.zip",
    })

    const worker = startWorker()
    try {
      await waitFor("archive entries recorded", async () => {
        const files = await fileRows(imp.id)
        return files.filter((f) => f.kind === "photo").length === 2
      })
      const photos = (await fileRows(imp.id)).filter((f) => f.kind === "photo")
      expect(photos.map((p) => p.filename).sort()).toEqual([
        "photos/blue.png",
        "photos/red.png",
      ])
      const red = photos.find((p) => p.filename === "photos/red.png")!
      expect(red.sha256).toBe(sha256(PNG_BYTES))
      expect(red.object_key).toBe(
        `imports/test-store/${imp.id}/photos/${sha256(PNG_BYTES)}.png`
      )
      const stored = await getTestObject(storage, red.object_key)
      expect(stored).toEqual(PNG_BYTES)
    } finally {
      await worker.stop()
    }
  })

  it("fails the import on path-traversal entry names (EC-006)", async () => {
    // yazl refuses to write unsafe names, so the fixture patches the entry
    // name bytes directly — exactly what a hostile archive carries.
    const benign = `photos/${"a".repeat(19)}.png` // same length as the hostile name
    const hostile = "photos/../../../etc/passwd.png"
    const zip = await buildZip([
      { name: "photos/red.png", data: PNG_BYTES },
      { name: benign, data: "evil" },
    ])
    const patched = patchZipEntryName(zip, benign, hostile)
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku"], ["TP-100"]])
    )
    const archiveKey = `t2-tests/${imp.id}/evil.zip`
    await putTestObject(storage, archiveKey, patched, "application/zip")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo_zip",
      objectKey: archiveKey,
      filename: "evil.zip",
    })

    const worker = startWorker()
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toContain("passwd.png")
      expect(row.failure_reason).toMatch(/unsafe|traversal|path/i)
      const events = await readEvents(imp.id)
      const done = events.find((e) => e.event.type === "import_done")!
      expect(done.event.data).toMatchObject({ status: "failed" })
      // No traversal entry may ever be extracted.
      const photos = (await fileRows(imp.id)).filter((f) => f.kind === "photo")
      expect(photos).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })

  it("fails the import on truncated archives (EC-006)", async () => {
    const zip = await buildZip([{ name: "photos/red.png", data: PNG_BYTES }])
    const corrupted = truncate(zip, zip.length - 24)
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku"], ["TP-100"]])
    )
    const archiveKey = `t2-tests/${imp.id}/broken.zip`
    await putTestObject(storage, archiveKey, corrupted, "application/zip")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo_zip",
      objectKey: archiveKey,
      filename: "broken.zip",
    })

    const worker = startWorker()
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/truncated|corrupt|incomplete/i)
    } finally {
      await worker.stop()
    }
  })

  it("fails the import when an archive decompresses past the cap (EC-008)", async () => {
    const zip = await buildZip([
      { name: "photos/big.png", data: Buffer.alloc(1024 * 1024, 7) },
    ])
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku"], ["TP-100"]])
    )
    const archiveKey = `t2-tests/${imp.id}/big.zip`
    await putTestObject(storage, archiveKey, zip, "application/zip")
    await seedImportFile(db, {
      importId: imp.id,
      kind: "photo_zip",
      objectKey: archiveKey,
      filename: "big.zip",
    })

    const worker = startWorker({ maxZipEntryBytes: 1024 })
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/big\.png/)
      expect(row.failure_reason).toMatch(/larger than|cap|exceed/i)
    } finally {
      await worker.stop()
    }
  })
})

describe("intake failure classes", () => {
  it("fails the import when the xlsx is an HTML page in disguise (EC-006)", async () => {
    const imp = await seedImport(db, {
      sheetFormat: "xlsx",
      originalFilename: "export.xlsx",
    })
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      Buffer.from("<html><body><h1>502 Bad Gateway</h1></body></html>", "utf8"),
      "text/html"
    )

    const worker = startWorker()
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/excel|workbook|html/i)
      const events = await readEvents(imp.id)
      expect(events.some((e) => e.event.type === "import_done")).toBe(true)
    } finally {
      await worker.stop()
    }
  })

  it("fails the import on a zero-byte sheet (EC-006)", async () => {
    const imp = await seedImport(db)
    await putTestObject(storage, imp.sheetObjectKey, Buffer.alloc(0))

    const worker = startWorker()
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/empty|0 bytes/i)
    } finally {
      await worker.stop()
    }
  })

  it("fails the import when the sheet exceeds the row cap (EC-008)", async () => {
    const rows: string[][] = [["sku"]]
    for (let i = 1; i <= 10; i++) rows.push([`SKU-${i}`])
    const imp = await seedImport(db)
    await putTestObject(storage, imp.sheetObjectKey, csvBytes(rows))

    const worker = startWorker({ maxSheetRows: 5 })
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/5 rows|row limit|more than 5/i)
    } finally {
      await worker.stop()
    }
  })

  it("fails the import on a header-only sheet (EC-011)", async () => {
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([["sku", "name"]])
    )

    const worker = startWorker()
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/no data rows|header/i)
    } finally {
      await worker.stop()
    }
  })

  it("refuses non-UTF-8 encodings instead of mojibake (EC-002)", async () => {
    // "sku;name\r\n1;Käse" encoded as UTF-16LE with BOM.
    const text = "sku;name\r\n1;Käse"
    const utf16 = Buffer.from("\ufeff" + text, "utf16le")
    const imp = await seedImport(db)
    await putTestObject(storage, imp.sheetObjectKey, utf16)

    const worker = startWorker()
    try {
      await waitFor("import failed", async () => {
        const row = await importRow(imp.id)
        return row.status === "failed"
      })
      const row = await importRow(imp.id)
      expect(row.failure_reason).toMatch(/utf-8|encoding|re-export/i)
    } finally {
      await worker.stop()
    }
  })
})

describe("intake idempotency (ADR-0003)", () => {
  it("re-running a completed intake converges: no duplicate rows or events", async () => {
    const imp = await seedImport(db)
    await putTestObject(
      storage,
      imp.sheetObjectKey,
      csvBytes([
        ["sku", "name"],
        ["TP-100", "Blumentopf"],
        ["TP-101", "Vase"],
      ])
    )

    const worker = startWorker()
    try {
      await waitFor("import advanced to clean", async () => {
        const row = await importRow(imp.id)
        return row.stage === "clean"
      })
    } finally {
      await worker.stop()
    }

    // Simulate a lost lease re-running the handler after advancement.
    const handler = createIntakeHandler({ storage, cache })
    const jobLike = {
      id: crypto.randomUUID(),
      storeId: imp.storeId,
      importId: imp.id,
      stage: "intake",
      batchKey: "intake",
      attempts: 2,
      maxAttempts: 5,
      status: "running",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as never
    await handler({
      job: jobLike,
      db: db.db,
      log: console as never,
    })

    const rows = await sheetRows(imp.id)
    expect(rows).toHaveLength(2)
    const events = await readEvents(imp.id)
    const stageChanges = events.filter((e) => e.event.type === "stage_changed")
    expect(stageChanges).toHaveLength(1)
  })
})
