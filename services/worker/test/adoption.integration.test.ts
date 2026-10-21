/**
 * Sweeper adoption — DB-contract seam.
 *
 * The app writes a queued Import (the contract fact); the Worker's Sweeper
 * adopts it and plans the intake Job. Tests run the real adoption against
 * live Postgres and assert observable state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"

import { adoptQueuedImports } from "../src/imports.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedImport,
} from "./helpers"

let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
})

beforeEach(async () => {
  await db.db.execute(sql`TRUNCATE jobs, imports, sheet_rows, import_files`)
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

interface JobRow {
  id: string
  import_id: string
  stage: string
  batch_key: string
  status: string
}

async function jobRows(): Promise<JobRow[]> {
  return (await db.db.execute(sql`
    SELECT id, import_id, stage, batch_key, status
    FROM jobs ORDER BY created_at, id
  `)) as unknown as JobRow[]
}

async function importStatus(
  importId: string
): Promise<{ status: string; stage: string }> {
  const rows = (await db.db.execute(sql`
    SELECT status, stage FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{ status: string; stage: string }>
  return rows[0]!
}

describe("sweeper adoption of queued imports", () => {
  it("plans one intake job and marks the import running", async () => {
    const imp = await seedImport(db)

    const adopted = await adoptQueuedImports(db.db)
    expect(adopted).toBe(1)

    const jobs = await jobRows()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      import_id: imp.id,
      stage: "intake",
      batch_key: "intake",
      status: "pending",
    })
    expect(await importStatus(imp.id)).toMatchObject({
      status: "running",
      stage: "intake",
    })
  })

  it("is idempotent: re-running adoption never plans a second job", async () => {
    const imp = await seedImport(db)

    expect(await adoptQueuedImports(db.db)).toBe(1)
    expect(await adoptQueuedImports(db.db)).toBe(0)

    const jobs = await jobRows()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.import_id).toBe(imp.id)
  })

  it("leaves imports in other statuses alone", async () => {
    await seedImport(db, { status: "running" })
    await seedImport(db, { status: "failed" })
    await seedImport(db, { status: "completed" })

    expect(await adoptQueuedImports(db.db)).toBe(0)
    expect(await jobRows()).toHaveLength(0)
  })

  it("adopts every queued import in one sweep", async () => {
    await seedImport(db)
    await seedImport(db)
    await seedImport(db)

    expect(await adoptQueuedImports(db.db)).toBe(3)
    expect(await jobRows()).toHaveLength(3)
  })
})
