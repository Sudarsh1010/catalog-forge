/**
 * Claim-ordering tests — the stage-gate seam (EC-123: translation needs
 * enrichment needs grouping). The enrich/translate Batches are planned at
 * match-media planning time (deterministic boundaries, ADR-0002), but the
 * claim gate keeps them unclaimable until the Import's stage has advanced
 * past their own: enrich runs only after match-media completes, translate
 * only after enrich, finalise only after translate. Non-pipeline Jobs
 * (and Jobs whose Import row is gone) stay claimable — the Job machinery's
 * own tests rely on that and out-of-pipeline stages have no ordering.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"

import type { WorkerConfig } from "../src/index.js"
import { claimJob, completeJob, resolveConfig } from "../src/index.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedImport,
} from "./helpers"

let db: Db
let config: WorkerConfig

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
  config = resolveConfig({ workerId: "w-ordering" })
})

beforeEach(async () => {
  await db.db.execute(sql`TRUNCATE translation_memory, jobs, imports CASCADE`)
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

async function insertJob(
  importId: string,
  stage: string,
  batchKey: string
): Promise<string> {
  const rows = (await db.db.execute(sql`
    INSERT INTO jobs (store_id, import_id, stage, batch_key)
    VALUES ('test-store', ${importId}, ${stage}, ${batchKey})
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

async function stageOf(importId: string): Promise<string> {
  const rows = (await db.db.execute(sql`
    SELECT stage FROM imports WHERE id = ${importId}
  `)) as unknown as Array<{ stage: string }>
  return rows[0]!.stage
}

describe("stage-gated claiming (EC-123)", () => {
  it("holds enrich/translate Jobs until match-media completes, then claims enrich first", async () => {
    const imp = await seedImport(db, {
      status: "running",
      stage: "match-media",
    })
    const mediaJob = await insertJob(imp.id, "match-media", "media")

    // A worker holds the media Job mid-Stage; the barrier fan-out already
    // planned the tail Batches (created later → FIFO order would claim the
    // media Job first, enrich next).
    expect((await claimJob(db.db, config))?.id).toBe(mediaJob)
    const enrichJob = await insertJob(
      imp.id,
      "enrich",
      "products-000001-000004"
    )
    await insertJob(imp.id, "translate", "products-000001-000004:de")
    await insertJob(imp.id, "translate", "products-000001-000004:fr")

    // Gated: enrich/translate are ahead of the Import's stage — no work.
    expect(await claimJob(db.db, config)).toBeNull()

    // Completing the media Job advances the Import to `enrich`; the enrich
    // Batch becomes claimable, and FIFO still picks it before translate.
    await completeJob(db.db, config, mediaJob)
    await expect(stageOf(imp.id)).resolves.toBe("enrich")
    const claimed = await claimJob(db.db, config)
    expect(claimed?.stage).toBe("enrich")
    expect(claimed?.id).toBe(enrichJob)
  })

  it("holds translate Jobs until the last enrich Job completes", async () => {
    const imp = await seedImport(db, { status: "running", stage: "enrich" })
    const enrichJob = await insertJob(
      imp.id,
      "enrich",
      "products-000001-000004"
    )
    await insertJob(imp.id, "translate", "products-000001-000004:de")

    // The worker holds the (only) enrich Job; the pending translate Job must
    // wait — the Import cannot enter `translate` until enrich completes.
    expect((await claimJob(db.db, config))?.id).toBe(enrichJob)
    expect(await claimJob(db.db, config)).toBeNull()

    await completeJob(db.db, config, enrichJob)
    await expect(stageOf(imp.id)).resolves.toBe("translate")
    const claimed = await claimJob(db.db, config)
    expect(claimed?.stage).toBe("translate")
  })

  it("keeps Jobs claimable when their Import row is gone", async () => {
    const orphan = await insertJob(crypto.randomUUID(), "enrich", "batch-1")
    const claimed = await claimJob(db.db, config)
    expect(claimed?.id).toBe(orphan)
  })

  it("gates the finalise Job until the Import enters finalise", async () => {
    const imp = await seedImport(db, { status: "running", stage: "translate" })
    const translateJob = await insertJob(
      imp.id,
      "translate",
      "products-000001-000004:de"
    )
    const finaliseJob = await insertJob(imp.id, "finalise", "finalise")

    // translate pending → finalise gated.
    expect((await claimJob(db.db, config))?.id).toBe(translateJob)
    expect(await claimJob(db.db, config)).toBeNull()

    // The finalise Job is planned when the Import ENTERS finalise — normally
    // by the translate completion's planner; here the job pre-exists, so
    // completing translate advances and the gate opens.
    await completeJob(db.db, config, translateJob, {
      finalise: async () => {},
    })
    await expect(stageOf(imp.id)).resolves.toBe("finalise")
    expect((await claimJob(db.db, config))?.id).toBe(finaliseJob)
  })
})
