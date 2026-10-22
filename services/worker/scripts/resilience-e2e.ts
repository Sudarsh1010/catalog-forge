/**
 * Kill-the-Worker e2e (Ticket 6 / EC-120): the restart-resume proof with
 * REAL processes. Generates the synthetic 10k-row sheet, uploads it over
 * HTTP to the running web app, starts a real Worker process, `kill -9`s it
 * mid-flight, restarts it, and asserts — against Postgres — that the Row
 * Ledger adds up to exactly the sheet total and zero duplicate Products
 * exist. Prints the measured rows/minute (the first scale number for the
 * technical write-up).
 *
 * Prerequisites: the dev stack up (postgres :5432, redis :6379, garage
 * :9000 — `pnpm services:up`) and the web app serving WEB_BASE_URL (default
 * http://127.0.0.1:3000 — `pnpm --filter web dev`). The script spawns and
 * SIGKILLs the real worker process; that is its point.
 *
 * Run: pnpm --filter @workspace/worker tsx scripts/resilience-e2e.ts [rows]
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import postgres from "postgres"

import { toCsv, generateSheet } from "./generate-sheet.js"

const ROWS = Number.parseInt(process.argv[2] ?? "10000", 10)
const WEB_BASE_URL = process.env.WEB_BASE_URL ?? "http://127.0.0.1:3000"
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"

/** Short leases/sweeps so the SIGKILL recovery is measured in seconds. */
const WORKER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL,
  REDIS_URL,
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_BUCKET: process.env.S3_BUCKET ?? "catalog-forge",
  S3_ACCESS_KEY_ID:
    process.env.S3_ACCESS_KEY_ID ?? "GK0123456789abcdef01234567",
  S3_SECRET_ACCESS_KEY:
    process.env.S3_SECRET_ACCESS_KEY ??
    "941431a5c0f40a678c1ecf010982a2a23f9536ada8d3893cd0641d78ac6cf53c",
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
  WORKER_CLAIM_INTERVAL_MS: "100",
  WORKER_HEARTBEAT_INTERVAL_MS: "2000",
  WORKER_LEASE_TTL_MS: "5000",
  WORKER_SWEEP_INTERVAL_MS: "3000",
  WORKER_BATCH_SIZE: "25",
}

interface ImportDto {
  id: string
  status: string
  stage: string
  rowCount: number | null
}

function spawnWorker(): number {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: WORKER_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk: Buffer) =>
    process.stdout.write(`[worker] ${chunk}`)
  )
  child.stderr.on("data", (chunk: Buffer) =>
    process.stderr.write(`[worker!] ${chunk}`)
  )
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.log(`[worker] exited with code ${code} (expected after kill -9)`)
    }
  })
  return child.pid!
}

/** The dev database the web app wrote the Import fact into. */
const dbClient = postgres(DATABASE_URL, { max: 4 })

async function fetchImport(id: string): Promise<ImportDto> {
  const response = await fetch(`${WEB_BASE_URL}/api/imports/${id}`)
  if (!response.ok) {
    throw new Error(`GET /api/imports/${id} → ${response.status}`)
  }
  const body = (await response.json()) as { import: ImportDto }
  return body.import
}

async function waitFor(
  message: string,
  check: () => Promise<boolean>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) {
      throw new Error(`e2e timed out waiting for: ${message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function main(): Promise<void> {
  console.log(`==> generating ${ROWS.toLocaleString("en-US")}-row sheet…`)
  const sheet = generateSheet(ROWS)
  const csv = toCsv(sheet)
  const tempDir = mkdtempSync(path.join(tmpdir(), "cf-resilience-"))
  const sheetPath = path.join(tempDir, "supplier-10k.csv")
  writeFileSync(sheetPath, csv, "utf8")
  console.log(`    ${sheetPath} (${(csv.length / 1024 / 1024).toFixed(1)} MB)`)

  console.log(`==> uploading via HTTP to ${WEB_BASE_URL}…`)
  const form = new FormData()
  form.append(
    "sheet",
    new Blob([csv], { type: "text/csv" }),
    "supplier-10k.csv"
  )
  const uploadAt = Date.now()
  const uploadResponse = await fetch(`${WEB_BASE_URL}/api/imports`, {
    method: "POST",
    body: form,
  })
  if (!uploadResponse.ok) {
    throw new Error(
      `upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`
    )
  }
  const ackAt = Date.now()
  const { import: uploaded, deduped } = (await uploadResponse.json()) as {
    import: ImportDto
    deduped?: boolean
  }
  if (deduped) {
    throw new Error(
      `content-hash dedupe hit an existing import (${uploaded.id}) — the dev ` +
        `database already imported this generated sheet. Re-run with a ` +
        `different row count or clean the import first.`
    )
  }
  console.log(`    import ${uploaded.id} acknowledged`)

  console.log(`==> starting real worker process…`)
  const workerStart = Date.now()
  let pid = spawnWorker()

  // Mid-flight = provider work in motion (enrich is where leases, chaos
  // and restart-resume really bite). A kill before that is too easy.
  await waitFor(
    "import to reach the enrich stage (mid-flight)",
    async () => {
      const imp = await fetchImport(uploaded.id)
      return ["enrich", "translate", "finalise"].includes(imp.stage)
    },
    300_000
  )
  const midFlight = await fetchImport(uploaded.id)
  console.log(
    `    mid-flight at stage "${midFlight.stage}" — sending SIGKILL to pid ${pid}`
  )
  const killedAt = Date.now()
  process.kill(pid, "SIGKILL")
  await new Promise((resolve) => setTimeout(resolve, 1_500)) // let it die

  console.log(`==> restarting worker (restart-resume proof)…`)
  const restartedAt = Date.now()
  pid = spawnWorker()

  await waitFor(
    "import to complete after restart",
    async () => {
      const imp = await fetchImport(uploaded.id)
      return imp.status === "completed" || imp.status === "failed"
    },
    900_000
  )
  const finishedAt = Date.now()
  const finished = await fetchImport(uploaded.id)
  try {
    process.kill(pid, "SIGKILL") // the proof is done; stop the worker
  } catch {
    // already gone
  }

  if (finished.status !== "completed") {
    throw new Error(`import ended as ${finished.status}, expected completed`)
  }

  console.log(`==> asserting the ledger and product uniqueness in Postgres…`)
  const ledger = (await dbClient`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE state = 'done')::int AS done,
             count(*) FILTER (WHERE state = 'needs_review')::int AS needs_review,
             count(*) FILTER (WHERE state = 'failed')::int AS failed
      FROM row_ledger WHERE import_id = ${uploaded.id}
    `) as unknown as Array<{
    total: number
    done: number
    needs_review: number
    failed: number
  }>
  const products = (await dbClient`
    SELECT count(*)::int AS n, count(DISTINCT natural_key_hash)::int AS distinct_keys
    FROM products WHERE import_id = ${uploaded.id}
  `) as unknown as Array<{ n: number; distinct_keys: number }>
  const sheetRows = (await dbClient`
    SELECT count(*)::int AS n FROM sheet_rows WHERE import_id = ${uploaded.id}
  `) as unknown as Array<{ n: number }>

  const total = ledger[0]!.total
  const accounted =
    ledger[0]!.done + ledger[0]!.needs_review + ledger[0]!.failed
  const failures: string[] = []
  if (sheetRows[0]!.n !== ROWS) {
    failures.push(`sheet_rows ${sheetRows[0]!.n} ≠ ${ROWS}`)
  }
  if (total !== ROWS || accounted !== ROWS) {
    failures.push(
      `ledger total ${total} (terminal ${accounted}) ≠ ${ROWS} — counts do not add up`
    )
  }
  if (products[0]!.n !== products[0]!.distinct_keys) {
    failures.push(
      `duplicate Products: ${products[0]!.n} rows vs ${products[0]!.distinct_keys} distinct natural keys`
    )
  }
  // Name the duplicates, don't just count them away: GROUP BY the natural
  // key so a regression reports exactly which keys collapsed.
  const dupes = (await dbClient`
    SELECT natural_key_hash, count(*)::int AS n
    FROM products WHERE import_id = ${uploaded.id}
    GROUP BY natural_key_hash HAVING count(*) > 1
    LIMIT 10
  `) as unknown as Array<{ natural_key_hash: string; n: number }>
  if (dupes.length > 0) {
    failures.push(
      `duplicate natural keys (GROUP BY): ${dupes
        .map((d) => `${d.natural_key_hash.slice(0, 12)}… ×${d.n}`)
        .join(", ")}`
    )
  }
  if (failures.length > 0) {
    throw new Error(`e2e assertions failed:\n- ${failures.join("\n- ")}`)
  }

  const minutes = (ms: number): string => (ms / 60_000).toFixed(2)
  const rowsPerMinute = Math.round(ROWS / ((finishedAt - workerStart) / 60_000))
  const rowsPerMinutePostRestart = Math.round(
    ROWS / ((finishedAt - restartedAt) / 60_000)
  )

  rmSync(tempDir, { recursive: true, force: true })
  await dbClient.end()

  console.log(`
================================ RESILIENCE E2E: PASS ================================
sheet rows                     : ${ROWS.toLocaleString("en-US")}
killed at stage                : ${midFlight.stage}
row ledger (done/review/failed): ${ledger[0]!.done} / ${ledger[0]!.needs_review} / ${ledger[0]!.failed}  (terminal total ${accounted})
products (distinct natural keys): ${products[0]!.n} / ${products[0]!.distinct_keys}  → zero duplicates
upload → acknowledgment        : ${((ackAt - uploadAt) / 1000).toFixed(1)}s (incl. sheet generation)
worker start → completed       : ${minutes(finishedAt - workerStart)} min
  kill -9 mid-flight at        : stage "${midFlight.stage}", ${((killedAt - workerStart) / 1000).toFixed(1)}s in
  outage (killed → restart)    : ${((restartedAt - killedAt) / 1000).toFixed(1)}s
  restart → completed          : ${minutes(finishedAt - restartedAt)} min
ROWS/MINUTE (first scale number): ${rowsPerMinute.toLocaleString("en-US")} rows/min
  (post-restart leg only       : ${rowsPerMinutePostRestart.toLocaleString("en-US")} rows/min)
======================================================================================`)
  process.exit(0)
}

main().catch(async (error: unknown) => {
  console.error(`RESILIENCE E2E: FAIL —`, error)
  await dbClient.end()
  process.exit(1)
})
