/**
 * Worker integration tests — the DB-contract seam.
 *
 * Tests seed Jobs (domain facts) and run the Worker's real loops in-process
 * against the live dev Postgres, then assert observable Postgres state.
 * Worker internals are never mocked; loop intervals and the clock are
 * injected so nothing sleeps real 30s.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"

import type { Db } from "@workspace/db"

import { claimJob } from "../src/jobs.js"
import { createWorker, defineHandlers, resolveConfig } from "../src/index.js"
import type { JobHandler } from "../src/handlers.js"
import {
  connectTestDb,
  createTestDatabase,
  dropTestDatabase,
  seedJob,
  waitFor,
} from "./helpers"

let db: Db

beforeAll(async () => {
  await createTestDatabase()
  db = connectTestDb()
})

afterAll(async () => {
  await db.close()
  await dropTestDatabase()
})

/** Fast loop config: everything runs within milliseconds, TTL 2s. */
function fastConfig(workerId: string) {
  return resolveConfig({
    workerId,
    claimIntervalMs: 10,
    heartbeatIntervalMs: 50,
    sweepIntervalMs: 25,
    leaseTtlMs: 2_000,
    batchSize: 10,
  })
}

async function jobRows() {
  return (await db.db.execute(sql`
    SELECT id, status, attempts, lease_owner, last_error FROM jobs ORDER BY created_at, id
  `)) as unknown as Array<{
    id: string
    status: string
    attempts: number
    lease_owner: string | null
    last_error: string | null
  }>
}

describe("worker claim/heartbeat/complete", () => {
  it("claims a seeded Job, heartbeats it, and completes it", async () => {
    const jobId = await seedJob(db)
    const worker = createWorker({
      db,
      handlers: defineHandlers({ enrich: async () => {} }),
      config: fastConfig("w-demo"),
    })
    worker.start()
    try {
      await waitFor("job completed", async () => {
        const rows = await jobRows()
        return rows.some(
          (row) => row.id === jobId && row.status === "completed"
        )
      })
      const rows = await jobRows()
      const job = rows.find((row) => row.id === jobId)
      expect(job?.status).toBe("completed")
      expect(job?.attempts).toBe(1)
      expect(job?.lease_owner).toBeNull()
    } finally {
      await worker.stop()
    }
  })
})

describe("lease expiry and retries", () => {
  it("reclaims a Job whose Lease expired and re-runs it", async () => {
    const jobId = await seedJob(db)

    // Simulate a crashed worker: claim, then die without completing.
    const crashed = resolveConfig({ workerId: "w-crashed", leaseTtlMs: 60_000 })
    const claimed = await claimJob(db.db, crashed)
    expect(claimed?.id).toBe(jobId)

    // Lease TTL backdated: the crashed worker's lease is now expired.
    await db.db.execute(sql`
      UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = ${jobId}
    `)

    const executions: string[] = []
    const handler: JobHandler = async ({ job }) => {
      executions.push(job.id)
    }
    const restarted = createWorker({
      db,
      handlers: defineHandlers({ enrich: handler }),
      config: fastConfig("w-restarted"),
    })
    restarted.start()
    try {
      await waitFor("job completed after reclaim", async () => {
        const rows = await jobRows()
        return rows.some(
          (row) => row.id === jobId && row.status === "completed"
        )
      })
      const rows = await jobRows()
      const job = rows.find((row) => row.id === jobId)
      expect(job?.attempts).toBe(2) // once by the crashed worker, once after reclaim
      expect(job?.lease_owner).toBeNull()
      expect(executions).toEqual([jobId]) // re-run exactly once by the restarted worker
    } finally {
      await restarted.stop()
    }
  })

  it("terminates a failing Job as Failed after 5 attempts", async () => {
    const jobId = await seedJob(db)
    const worker = createWorker({
      db,
      handlers: defineHandlers({
        enrich: async () => {
          throw new Error("provider exploded")
        },
      }),
      config: fastConfig("w-poison"),
    })
    worker.start()
    try {
      await waitFor("job failed terminally", async () => {
        const rows = await jobRows()
        return rows.some((row) => row.id === jobId && row.status === "failed")
      })
      const rows = await jobRows()
      const job = rows.find((row) => row.id === jobId)
      expect(job?.attempts).toBe(5)
      expect(job?.last_error).toBe("provider exploded")
    } finally {
      await worker.stop()
    }
  })
})

describe("racing claim loops", () => {
  it("two claim loops racing never both execute the same Job", async () => {
    // Database-side execution ledger: (job_id) is the primary key, so a
    // second execution of the same Job would violate the constraint and the
    // Job would end Failed — observable purely through database state.
    await db.db.execute(sql`
      CREATE TABLE IF NOT EXISTS job_executions (
        job_id uuid PRIMARY KEY,
        worker_id text NOT NULL
      )
    `)
    const jobIds = new Set<string>()
    for (let i = 0; i < 25; i++) {
      jobIds.add(await seedJob(db, { batchKey: `batch-${i}` }))
    }

    const handler: JobHandler = async ({ job }) => {
      await db.db.execute(sql`
        INSERT INTO job_executions (job_id, worker_id) VALUES (${job.id}, ${job.leaseOwner})
      `)
      // Deliberate real delay: integration test widening the claim-race
      // window against the platform clock while both loops run concurrently.
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const workers = [
      createWorker({
        db,
        handlers: defineHandlers({ enrich: handler }),
        config: fastConfig("w-race-a"),
      }),
      createWorker({
        db,
        handlers: defineHandlers({ enrich: handler }),
        config: fastConfig("w-race-b"),
      }),
    ]
    for (const worker of workers) worker.start()
    try {
      await waitFor("all racing jobs completed", async () => {
        const rows = await jobRows()
        return rows.every(
          (row) => !jobIds.has(row.id) || row.status === "completed"
        )
      })
      const rows = await jobRows()
      const raced = rows.filter((row) => jobIds.has(row.id))
      // Every job completed exactly once, attempts never doubled.
      expect(raced).toHaveLength(25)
      expect(raced.every((row) => row.status === "completed")).toBe(true)
      expect(raced.every((row) => row.attempts === 1)).toBe(true)
      const executions = (await db.db.execute(sql`
        SELECT count(*)::int AS n FROM job_executions
      `)) as unknown as Array<{ n: number }>
      expect(executions[0]?.n).toBe(25)
    } finally {
      for (const worker of workers) await worker.stop()
    }
  })
})

describe("restart", () => {
  it("restarting the worker loses zero pending work", async () => {
    const jobIds = new Set<string>()
    for (let i = 0; i < 10; i++) {
      jobIds.add(await seedJob(db, { batchKey: `batch-${i}` }))
    }

    // First worker "crashes": every execution aborts mid-flight.
    const crashGate = Promise.withResolvers<void>()
    const crashingWorker = createWorker({
      db,
      handlers: defineHandlers({
        enrich: async () => {
          await crashGate.promise
          throw new Error("worker died mid-job") // unreachable until gate opens
        },
      }),
      config: fastConfig("w-v1"),
    })
    crashingWorker.start()
    await waitFor("crashing worker holds jobs", async () => {
      const rows = await jobRows()
      return rows.some((row) => jobIds.has(row.id) && row.status === "running")
    })

    // Crash: stop the loops; open the gate so stop() can settle, and the
    // in-flight jobs fail back to pending (attempts < max).
    const stopping = crashingWorker.stop()
    crashGate.resolve()
    await stopping

    // Expire any leases the dead worker still held (a real crash waits for TTL).
    await db.db.execute(sql`
      UPDATE jobs SET lease_expires_at = now() - interval '1 second'
      WHERE status = 'running'
    `)

    // Restart: the new worker sweeps expired leases and drains the queue.
    const finishedByRestart: string[] = []
    const restartedWorker = createWorker({
      db,
      handlers: defineHandlers({
        enrich: async ({ job }) => {
          finishedByRestart.push(job.id)
        },
      }),
      config: fastConfig("w-v2"),
    })
    restartedWorker.start()
    try {
      await waitFor("all jobs completed after restart", async () => {
        const rows = await jobRows()
        return rows.every(
          (row) => !jobIds.has(row.id) || row.status === "completed"
        )
      })
      const rows = await jobRows()
      const all = rows.filter((row) => jobIds.has(row.id))
      expect(all).toHaveLength(10)
      expect(all.every((row) => row.status === "completed")).toBe(true)
      expect(new Set(finishedByRestart)).toEqual(jobIds) // nothing lost, nothing skipped
    } finally {
      await restartedWorker.stop()
    }
  })
})
