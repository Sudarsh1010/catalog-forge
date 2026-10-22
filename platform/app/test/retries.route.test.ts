/**
 * Dashboard retry route (Ticket 6 poison path) — plain HTTP against a real
 * `next dev`. The route writes one `job_retries` FACT per terminally-failed
 * Job (ADR-0004: the app never touches Job machinery) and rejects malformed
 * input without touching the database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"

import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  startTestApp,
  truncateTables,
  type TestApp,
} from "./helpers"

let app: TestApp
let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  app = await startTestApp()
})

beforeEach(async () => {
  await truncateTables(db)
})

afterAll(async () => {
  await app.close()
  await db.close()
  await dropTestDatabase()
})

async function seedImportRow(): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO imports (id, store_id, content_hash, original_filename,
                         sheet_format, sheet_object_key, status, stage)
    VALUES (${id}, 'default', ${crypto.randomUUID()}, 'sheet.csv',
            'csv', 'imports/default/sheet.csv', 'running', 'enrich')
  `)
  return id
}

async function seedFailedJob(
  importId: string,
  batchKey: string
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO jobs (id, store_id, import_id, stage, batch_key, status, attempts, max_attempts)
    VALUES (${id}, 'default', ${importId}, 'enrich', ${batchKey}, 'failed', 5, 5)
  `)
  return id
}

describe("POST /api/imports/[id]/retries (retry fact)", () => {
  it("records retry facts for every failed job and reports 202", async () => {
    const importId = await seedImportRow()
    const jobA = await seedFailedJob(importId, "products-000001-000100")
    const jobB = await seedFailedJob(importId, "products-000101-000200")

    const response = await fetch(
      `${app.baseUrl}/api/imports/${importId}/retries`,
      { method: "POST" }
    )
    expect(response.status).toBe(202)
    const payload = (await response.json()) as {
      requested: number
      jobIds: string[]
    }
    expect(payload.requested).toBe(2)
    expect([...payload.jobIds].sort()).toEqual([jobA, jobB].sort())

    const facts = (await db.db.execute(sql`
      SELECT store_id, import_id, job_id FROM job_retries
      WHERE import_id = ${importId}
    `)) as unknown as Array<{
      store_id: string
      import_id: string
      job_id: string
    }>
    expect(facts.map((fact) => fact.job_id).sort()).toEqual([jobA, jobB].sort())
    expect(facts[0]).toMatchObject({ store_id: "default", import_id: importId })
  })

  it("retries only the selected jobs when jobIds is given", async () => {
    const importId = await seedImportRow()
    await seedFailedJob(importId, "products-000001-000100")
    const jobB = await seedFailedJob(importId, "products-000101-000200")

    const response = await fetch(
      `${app.baseUrl}/api/imports/${importId}/retries`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobIds: [jobB] }),
      }
    )
    expect(response.status).toBe(202)
    const payload = (await response.json()) as { requested: number }
    expect(payload.requested).toBe(1)
  })

  it("is idempotent: a repeat click inserts no second fact", async () => {
    const importId = await seedImportRow()
    await seedFailedJob(importId, "products-000001-000100")

    for (let i = 0; i < 2; i++) {
      const response = await fetch(
        `${app.baseUrl}/api/imports/${importId}/retries`,
        { method: "POST" }
      )
      expect(response.status).toBe(202)
    }
    const facts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM job_retries WHERE import_id = ${importId}
    `)) as unknown as Array<{ count: number }>
    expect(facts[0]!.count).toBe(1)
  })

  it("rejects non-uuid jobIds with 400 and records nothing", async () => {
    const importId = await seedImportRow()

    const response = await fetch(
      `${app.baseUrl}/api/imports/${importId}/retries`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobIds: "nope" }),
      }
    )
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { code: string } }
    expect(payload.error.code).toBe("invalid_job_ids")

    const facts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM job_retries WHERE import_id = ${importId}
    `)) as unknown as Array<{ count: number }>
    expect(facts[0]!.count).toBe(0)
  })

  it("returns 404 for unknown and malformed import ids", async () => {
    const missing = await fetch(
      `${app.baseUrl}/api/imports/${crypto.randomUUID()}/retries`,
      { method: "POST" }
    )
    expect(missing.status).toBe(404)

    // A non-UUID id must not become a Postgres cast error (500).
    const malformed = await fetch(
      `${app.baseUrl}/api/imports/not-a-uuid/retries`,
      { method: "POST" }
    )
    expect(malformed.status).toBe(404)
  })
})
