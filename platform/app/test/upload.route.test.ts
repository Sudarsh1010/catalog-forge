/**
 * Upload route — the web seam: plain HTTP requests against a real `next dev`
 * server. Broken-fixture tests run worker `intake` in-process afterwards and
 * assert the merchant-fixable failure reason over plain HTTP (GET), covering
 * the EC-006/EC-008 classes end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { request as httpRequest } from "node:http"
import { eq, sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import type { Cache } from "@workspace/cache"
import type { Storage } from "@workspace/storage"
import { importFiles, sheetRows } from "@workspace/db/schema"
import { createIntakeHandler, createWorker } from "@workspace/worker"

import {
  blob,
  buildZip,
  connectTestDb,
  createTestDatabase,
  csvBytes,
  dropTestDatabase,
  flushTestRedis,
  PNG_BYTES,
  startTestApp,
  truncateTables,
  testCache,
  testStorage,
  truncate,
  waitFor,
  type TestApp,
} from "./helpers"

let app: TestApp
let db: Db
let storage: Storage
let cache: Cache

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  storage = testStorage()
  cache = testCache()
  await flushTestRedis()
  app = await startTestApp()
})

beforeEach(async () => {
  await truncateTables(db)
})

afterAll(async () => {
  await app.close()
  await db.close()
  await flushTestRedis()
  await dropTestDatabase()
})

function postUpload(form: FormData): Promise<Response> {
  return fetch(`${app.baseUrl}/api/imports`, { method: "POST", body: form })
}

interface ImportPayload {
  import: {
    id: string
    status: string
    stage: string
    rowCount: number | null
    failureReason: string | null
    originalFilename: string
  }
  deduped: boolean
}

async function fetchImport(id: string): Promise<ImportPayload["import"]> {
  const response = await fetch(`${app.baseUrl}/api/imports/${id}`)
  expect(response.ok).toBe(true)
  const payload = (await response.json()) as { import: ImportPayload["import"] }
  return payload.import
}

/** Run the real worker loops in-process until the import reaches a terminal state. */
async function runIntakeUntil(
  importId: string,
  until: (row: ImportPayload["import"]) => boolean
): Promise<void> {
  const handler = createIntakeHandler({ storage, cache })
  const worker = createWorker({
    db,
    handlers: { intake: handler },
    cache,
    config: {
      claimIntervalMs: 10,
      sweepIntervalMs: 25,
      heartbeatIntervalMs: 100,
      leaseTtlMs: 5_000,
      batchSize: 5,
    },
  })
  worker.start()
  try {
    await waitFor("import reached expected state", async () =>
      until(await fetchImport(importId))
    )
  } finally {
    await worker.stop()
  }
}

describe("POST /api/imports", () => {
  it("accepts a CSV plus photos and a ZIP, returning an immediate acknowledgment", async () => {
    const form = new FormData()
    form.append(
      "sheet",
      blob(
        csvBytes([
          ["sku", "name"],
          ["TP-100", "Blumentopf"],
        ]),
        "text/csv"
      ),
      "supplier.csv"
    )
    form.append("photos", blob(PNG_BYTES, "image/png"), "red.png")
    form.append(
      "zip",
      blob(
        await buildZip([{ name: "blue.png", data: "b" }]),
        "application/zip"
      ),
      "photos.zip"
    )

    const response = await postUpload(form)
    expect(response.status).toBe(201)
    const payload = (await response.json()) as ImportPayload
    expect(payload.deduped).toBe(false)
    expect(payload.import.status).toBe("queued")
    expect(payload.import.stage).toBe("intake")
    expect(payload.import.originalFilename).toBe("supplier.csv")

    // The files exist in storage and the file records landed.
    const fileRows = await db.db
      .select()
      .from(importFiles)
      .where(eq(importFiles.importId, payload.import.id))
    expect(fileRows.map((f) => f.kind).sort()).toEqual([
      "photo",
      "photo_zip",
      "sheet",
    ])
  })

  it("re-uploading identical content returns the same Import and is a no-op", async () => {
    const csv = csvBytes([["sku"], ["TP-100"]])
    const buildForm = (): FormData => {
      const form = new FormData()
      form.append("sheet", blob(csv, "text/csv"), "same-sheet.csv")
      return form
    }

    const first = await postUpload(buildForm())
    expect(first.status).toBe(201)
    const firstPayload = (await first.json()) as ImportPayload

    const second = await postUpload(buildForm())
    expect(second.status).toBe(200)
    const secondPayload = (await second.json()) as ImportPayload
    expect(secondPayload.deduped).toBe(true)
    expect(secondPayload.import.id).toBe(firstPayload.import.id)

    const count = (await db.db.execute(sql`
      SELECT COUNT(*)::int AS n FROM imports
    `)) as unknown as Array<{ n: number }>
    expect(count[0]!.n).toBe(1)
  })

  it("rejects wrong sheet types with a friendly 415", async () => {
    const form = new FormData()
    form.append(
      "sheet",
      blob(Buffer.from("definitely not a sheet"), "application/pdf"),
      "invoice.pdf"
    )
    const response = await postUpload(form)
    expect(response.status).toBe(415)
    const payload = (await response.json()) as {
      error: { message: string; code: string }
    }
    expect(payload.error.code).toBe("unsupported_type")
    expect(payload.error.message).toContain("invoice.pdf")
    expect(payload.error.message).toMatch(/csv|xlsx/i)
  })

  it("rejects a zero-byte sheet with a friendly 400", async () => {
    const form = new FormData()
    form.append("sheet", blob(Buffer.alloc(0), "text/csv"), "empty.csv")
    const response = await postUpload(form)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as {
      error: { message: string }
    }
    expect(payload.error.message).toMatch(/empty|0 bytes/i)
  })

  it("rejects uploads declaring more than the request cap with a 413", async () => {
    // undici's fetch refuses to lie about content-length, so speak raw HTTP.
    const { hostname, port } = new URL(app.baseUrl)
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname,
          port,
          path: "/api/imports",
          method: "POST",
          headers: {
            "content-type":
              "multipart/form-data; boundary=---------------------------9051914041544843365972754266",
            "content-length": String(700 * 1024 * 1024),
          },
        },
        (response) => {
          response.resume()
          response.on("end", () => resolve(response.statusCode ?? 0))
        }
      )
      request.on("error", reject)
      request.end("small body, big claim")
    })
    expect(status).toBe(413)
  })

  it("rejects a request without a sheet with a friendly 400", async () => {
    const form = new FormData()
    form.append("photos", blob(PNG_BYTES, "image/png"), "lone.png")
    const response = await postUpload(form)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as {
      error: { code: string }
    }
    expect(payload.error.code).toBe("missing_sheet")
  })
})

describe("broken fixtures fail the import with friendly reasons (EC-006/EC-008)", () => {
  it("truncated photo ZIP → import failed with a clear reason (EC-006)", async () => {
    const zip = await buildZip([{ name: "photos/red.png", data: PNG_BYTES }])
    const corrupted = truncate(zip, zip.length - 24)

    const form = new FormData()
    form.append(
      "sheet",
      blob(csvBytes([["sku"], ["TP-100"]]), "text/csv"),
      "sheet.csv"
    )
    form.append("zip", blob(corrupted, "application/zip"), "broken.zip")
    const upload = await postUpload(form)
    expect(upload.status).toBe(201)
    const { import: created } = (await upload.json()) as ImportPayload

    await runIntakeUntil(created.id, (row) => row.status === "failed")
    const row = await fetchImport(created.id)
    expect(row.failureReason).toMatch(/truncated|corrupt/i)
  })

  it("HTML saved as .xlsx → import failed with a clear reason (EC-006)", async () => {
    const form = new FormData()
    form.append(
      "sheet",
      // Passes cheap validation: the extension is .xlsx.
      blob(
        Buffer.from("<html><body><h1>502 Bad Gateway</h1></body></html>"),
        "text/html"
      ),
      "export.xlsx"
    )
    const upload = await postUpload(form)
    expect(upload.status).toBe(201)
    const { import: created } = (await upload.json()) as ImportPayload

    await runIntakeUntil(created.id, (row) => row.status === "failed")
    const row = await fetchImport(created.id)
    expect(row.failureReason).toMatch(/excel|workbook|html/i)
  })

  it("a healthy sheet still lands raw rows after the broken-fixture run (sanity)", async () => {
    const form = new FormData()
    form.append(
      "sheet",
      blob(
        csvBytes([
          ["sku", "name"],
          ["TP-100", "Blumentopf"],
          ["TP-101", "Vase"],
        ]),
        "text/csv"
      ),
      "sheet.csv"
    )
    const upload = await postUpload(form)
    const { import: created } = (await upload.json()) as ImportPayload

    await runIntakeUntil(
      created.id,
      (row) => row.stage === "clean" && row.rowCount === 2
    )
    const rows = await db.db
      .select()
      .from(sheetRows)
      .where(eq(sheetRows.importId, created.id))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.raw).toEqual(["TP-100", "Blumentopf"])
  })
})
