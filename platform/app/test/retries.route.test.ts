/**
 * Dashboard retry procedure (Ticket 6 poison path) — via the typed oRPC
 * client against a real `next dev` (RPC mount at /api/rpc). It writes one
 * `job_retries` FACT per terminally-failed Job (ADR-0004: the app never
 * touches Job machinery) and rejects malformed input without touching the
 * database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"
import { createORPCClient, isDefinedError, ORPCError, safe } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import type { ClientContract } from "@workspace/contracts"

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
let client: ClientContract

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  app = await startTestApp()
  client = createORPCClient(new RPCLink({ url: `${app.baseUrl}/api/rpc` }))
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

describe("import.retry (retry fact)", () => {
  it("records retry facts for every failed job", async () => {
    const importId = await seedImportRow()
    const jobA = await seedFailedJob(importId, "products-000001-000100")
    const jobB = await seedFailedJob(importId, "products-000101-000200")

    const payload = await client.import.retry({ id: importId })
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

    const payload = await client.import.retry({ id: importId, jobIds: [jobB] })
    expect(payload.requested).toBe(1)
  })

  it("is idempotent: a repeat click inserts no second fact", async () => {
    const importId = await seedImportRow()
    await seedFailedJob(importId, "products-000001-000100")

    for (let i = 0; i < 2; i++) {
      await client.import.retry({ id: importId })
    }
    const facts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM job_retries WHERE import_id = ${importId}
    `)) as unknown as Array<{ count: number }>
    expect(facts[0]!.count).toBe(1)
  })

  it("rejects non-uuid jobIds as a validation error and records nothing", async () => {
    const importId = await seedImportRow()

    const [error] = await safe(
      client.import.retry({
        id: importId,
        jobIds: "nope" as unknown as string[],
      })
    )
    expect(isDefinedError(error)).toBe(false)
    expect(error).toBeInstanceOf(ORPCError)
    expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST")

    const facts = (await db.db.execute(sql`
      SELECT count(*)::int AS count FROM job_retries WHERE import_id = ${importId}
    `)) as unknown as Array<{ count: number }>
    expect(facts[0]!.count).toBe(0)
  })

  it("throws IMPORT_NOT_FOUND for unknown and malformed import ids", async () => {
    const [missingError] = await safe(
      client.import.retry({ id: crypto.randomUUID() })
    )
    expect(isDefinedError(missingError)).toBe(true)
    if (isDefinedError(missingError)) {
      expect(missingError.code).toBe("IMPORT_NOT_FOUND")
      expect(missingError.message).toBe("Import not found.")
    }

    // A non-UUID id must not become a Postgres cast error (500).
    const [malformedError] = await safe(
      client.import.retry({ id: "not-a-uuid" })
    )
    expect(isDefinedError(malformedError)).toBe(false)
    expect(malformedError).toBeInstanceOf(ORPCError)
    expect((malformedError as ORPCError<string, unknown>).code).toBe(
      "BAD_REQUEST"
    )
  })
})
