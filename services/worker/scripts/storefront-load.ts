/**
 * Storefront p95 load test under 10k-import churn (Ticket 21 / spec user
 * story on the product surface). Proves two things at once, in one run:
 *
 *  1. The read-only storefront (ADR-0005: Publications-only reads, no
 *     staging joins) stays fast WHILE the pipeline churns a 10,000-row
 *     import in the same Postgres — worst-window p95 stays inside a stated
 *     bound and shows no import-coupled spike versus its own median window.
 *  2. No AI calls originate from the storefront path: the app runs keyless
 *     (Demo Mode — zero provider credentials, enforced before boot), its
 *     logs are scanned for any provider/enrich/translate activity, and the
 *     only AI-capable process in the run is the Worker's stub provider.
 *
 * How it works: generates the synthetic 10k sheet (same deterministic
 * fixture as the resilience e2e), builds + starts the app in production
 * mode (`next build` + `next start` — dev-mode compile noise would poison
 * p95), seeds a Publication catalog (the storefront read model — written
 * at approval, never by an Import Stage, so the harness seeds it the way
 * an approval would), uploads the sheet over HTTP and drives it with a
 * real keyless Worker process, then hammers `/storefront` (collection) and
 * `/storefront/[handle]` (product) SIMULTANEOUSLY with autocannon while
 * the import runs. Reports storefront p95 and import rows/min together,
 * as JSON and human-readable, saved to `eval/load-results.md`.
 *
 * Prerequisites: dev services up (postgres :5432, redis :6379, garage
 * :9000 — `pnpm services:up`). Keyless by construction: any AI provider
 * credential in the environment aborts the run.
 *
 * Run: pnpm --filter @workspace/worker load:storefront [rows=10000]
 * Env: ROWS, SEED_PRODUCTS, CONNECTIONS, BURST_MS, LOAD_WINDOW_CAP_MS,
 *      P95_BOUND_MS, SPIKE_FACTOR, IMPORT_TIMEOUT_MS, SKIP_BUILD=1,
 *      KEEP_SEED=1, LOAD_OUT_DIR
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:net"

import autocannon from "autocannon"
import postgres from "postgres"

import { runMigrations } from "@workspace/db/migrate"

import { generateSheet, toCsv } from "./generate-sheet.js"

// ----------------------------------------------------------- configuration --

/** `next/dist/bin/next` resolves from the app package, not this ESM script. */
const require = createRequire(import.meta.url)
/**
 * Spawn children via PATH's `node`: the running process's `process.execPath`
 * (a nix store path) can be garbage-collected mid-run, making child spawns
 * fail with ENOENT. NODE_BIN overrides for reproducible environments.
 */
const NODE_BIN = process.env.NODE_BIN ?? "node"

const ROWS = Number.parseInt(process.argv[2] ?? process.env.ROWS ?? "10000", 10)
/**
 * PRNG seed for the sheet. Random per run on purpose: the Import identity IS
 * the sheet's content hash (GLOSSARY: Import), so a fixed seed would collide
 * with the resilience e2e's default-seed 10k sheet already in the shared dev
 * database and dedupe-hit. SHEET_SEED pins it for reproducibility.
 */
const SHEET_SEED = Number.parseInt(
  process.env.SHEET_SEED ?? String(Date.now() % 1_000_000),
  10
)
const SEED_PRODUCTS = Number.parseInt(process.env.SEED_PRODUCTS ?? "200", 10)
const CONNECTIONS = Number.parseInt(process.env.CONNECTIONS ?? "20", 10)
const BURST_MS = Number.parseInt(process.env.BURST_MS ?? "5000", 10)
/**
 * Load sampling stops after this even if the import still runs. 0 (the
 * default) spans the WHOLE import — the barrier stages (group fan-in,
 * finalise) are exactly where import-coupled latency would show, so the
 * sampled window must not end before they do.
 */
const LOAD_WINDOW_CAP_MS = Number.parseInt(
  process.env.LOAD_WINDOW_CAP_MS ?? "0",
  10
)
/**
 * Stated bound, measured on this host across three full reference runs
 * (2026-10-22): worst-window p95 during churn landed at 720.3ms, 946.3ms
 * and 1142ms (product route) while siblings shared the box — the ceiling
 * is stated from those measurements, not from the pre-import baseline (a
 * 200-card collection render under 20 concurrent SSRs is hundreds of ms on
 * its own). The coupling detector is the spike factor below; this is the
 * absolute responsiveness ceiling. Override to restate.
 */
const P95_BOUND_MS = Number.parseInt(process.env.P95_BOUND_MS ?? "1250", 10)
/** No import-coupled spike: worst window ≤ SPIKE_FACTOR × median window. */
const SPIKE_FACTOR = Number.parseFloat(process.env.SPIKE_FACTOR ?? "5")
const IMPORT_TIMEOUT_MS = Number.parseInt(
  process.env.IMPORT_TIMEOUT_MS ?? "900000",
  10
)
const WEB_PORT = Number.parseInt(process.env.WEB_PORT ?? "0", 10)

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"

const SERVICE_ENV: NodeJS.ProcessEnv = {
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
}

const APP_DIR = path.resolve(import.meta.dirname, "../../../platform/app")
const OUT_DIR =
  process.env.LOAD_OUT_DIR ?? path.resolve(import.meta.dirname, "../../../eval")

/** Any of these in the environment would make "no AI calls" unverifiable. */
const AI_CREDENTIAL_PATTERN =
  /(OPENAI|ANTHROPIC|GEMINI|GOOGLE_(API|APPLICATION)|OPENROUTER|GROQ|MISTRAL|COHERE|DEEPSEEK|TOGETHER|FIREWORKS|XAI|GROK|AI_PROVIDER)/i
/** Evidence of AI/pipeline work in the web app's own output. */
const AI_LOG_PATTERN = /\b(provider|enrich|translate|translation|stub)\b/i

interface BurstResult {
  p50Ms: number
  p90Ms: number
  p95Ms: number
  meanMs: number
  maxMs: number
  requests: number
  errors: number
  non2xx: number
}

interface RouteLoad {
  /** Worst 5s-window p95 observed while the import was churning. */
  worstWindowP95Ms: number
  medianWindowP95Ms: number
  meanWindowP95Ms: number
  windowP95sMs: number[]
  requests: number
  errors: number
  non2xx: number
}

interface LoadReport {
  ticket: "21"
  generatedAt: string
  config: {
    sheetRows: number
    sheetSeed: number
    seedProducts: number
    connections: number
    burstMs: number
    p95BoundMs: number
    spikeFactor: number
  }
  import: {
    id: string
    status: string
    rows: number
    elapsedMs: number
    rowsPerMinute: number
    uploadToAckMs: number
  }
  storefront: {
    collection: { baselineP95Ms: number } & RouteLoad
    product: { baselineP95Ms: number; handlesSampled: number } & RouteLoad
  }
  noAiCalls: {
    keylessEnv: string
    appLogScan: string
    designGuarantee: string
  }
  bounds: {
    p95WithinBound: boolean
    noImportCoupledSpike: boolean
    noRouteErrors: boolean
    importCompleted: boolean
  }
  pass: boolean
}

// ------------------------------------------------------------------ helpers --

function fail(message: string): never {
  console.error(`STOREFRONT LOAD: FAIL — ${message}`)
  process.exit(1)
}

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close()
    if (address && typeof address === "object" && "port" in address) {
      resolve(address.port)
    } else {
      reject(new Error("could not determine a free port"))
    }
  })
  return promise
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
      throw new Error(`timed out waiting for: ${message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** One autocannon burst: a real concurrent load window against one route. */
function burst(
  url: string,
  durationMs: number,
  connections: number
): Promise<BurstResult> {
  const { promise, resolve, reject } = Promise.withResolvers<BurstResult>()
  autocannon(
    { url, duration: durationMs / 1000, connections },
    (error, result) => {
      if (error) {
        reject(error)
        return
      }
      const non2xx =
        result["1xx"] + result["3xx"] + result["4xx"] + result["5xx"]
      const p95Ms = p95Of(result.latency)
      const round1 = (ms: number): number => Math.round(ms * 10) / 10
      resolve({
        p50Ms: round1(result.latency.p50),
        p90Ms: round1(result.latency.p90),
        p95Ms: round1(p95Ms),
        meanMs: round1(result.latency.mean),
        maxMs: round1(result.latency.max),
        requests: result.requests.total,
        errors: result.errors,
        non2xx,
      })
    }
  )
  return promise
}

function summarizeWindows(
  windows: BurstResult[]
): Omit<RouteLoad, "baselineP95Ms"> {
  const p95s = windows.map((w) => w.p95Ms).sort((a, b) => a - b)
  const median = p95s[Math.floor(p95s.length / 2)] ?? 0
  const mean =
    p95s.length > 0 ? p95s.reduce((a, b) => a + b, 0) / p95s.length : 0
  return {
    worstWindowP95Ms: p95s[p95s.length - 1] ?? 0,
    medianWindowP95Ms: median,
    meanWindowP95Ms: Number.parseFloat(mean.toFixed(1)),
    windowP95sMs: windows.map((w) => w.p95Ms),
    requests: windows.reduce((a, w) => a + w.requests, 0),
    errors: windows.reduce((a, w) => a + w.errors, 0),
    non2xx: windows.reduce((a, w) => a + w.non2xx, 0),
  }
}

/**
 * autocannon's latency histogram ships p90 and p97_5 but no p95 bucket at
 * runtime (its type declarations claim otherwise). Linear interpolation
 * between the two neighbouring buckets is the p95 the histogram implies.
 */
function p95Of(latency: { p90: number; p97_5: number }): number {
  return latency.p90 + ((latency["p97_5"] - latency.p90) * 5) / 7.5
}

// --------------------------------------------------------------------- app --

interface AppHandle {
  baseUrl: string
  kill: () => Promise<void>
  aiLogHits: () => number
  logTail: () => string
}

/** Spawn a Next.js command directly (SIGTERM must reach the server itself). */
function spawnNext(
  args: string[],
  onChunk?: (chunk: Buffer) => void
): Promise<number> {
  const nextBin = require.resolve("next/dist/bin/next", { paths: [APP_DIR] })
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const child = spawn(NODE_BIN, [nextBin, ...args], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ...SERVICE_ENV,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000)
    onChunk?.(chunk)
  }
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)
  child.on("exit", (code) => {
    if (code === 0) resolve(0)
    else reject(new Error(`next ${args[0]} exited ${code}\n${output}`))
  })
  child.on("error", reject)
  return promise
}

async function startApp(): Promise<AppHandle> {
  // Keyless Demo Mode, enforced BEFORE anything boots: any provider
  // credential in the environment aborts the run.
  const credentialLeak = Object.keys(process.env).filter((key) =>
    AI_CREDENTIAL_PATTERN.test(key)
  )
  if (credentialLeak.length > 0) {
    fail(
      `AI provider credentials present in env (${credentialLeak.join(", ")}) ` +
        `— "no AI calls from storefront" is only verifiable keyless (Demo Mode)`
    )
  }

  if (
    process.env.SKIP_BUILD !== "1" ||
    !existsSync(path.join(APP_DIR, ".next/BUILD_ID"))
  ) {
    console.log(
      `==> building app (production — dev-mode compile noise would poison p95)…`
    )
    await spawnNext(["build"])
  } else {
    console.log(`==> SKIP_BUILD=1, reusing existing production build`)
  }

  const port = WEB_PORT > 0 ? WEB_PORT : await freePort()
  const nextBin = require.resolve("next/dist/bin/next", { paths: [APP_DIR] })
  const baseUrl = `http://127.0.0.1:${port}`

  let logText = ""
  let aiHits = 0
  const child = spawn(
    NODE_BIN,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: APP_DIR,
      // Explicitly keyless: service vars only, no provider credentials.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...SERVICE_ENV,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString()
    logText = (logText + text).slice(-16000)
    if (AI_LOG_PATTERN.test(text)) aiHits += 1
  }
  child.stdout?.on("data", onChunk)
  child.stderr?.on("data", onChunk)

  try {
    await waitFor(
      "app to serve",
      async () => {
        if (child.exitCode !== null) {
          throw new Error(`next start exited early with code ${child.exitCode}`)
        }
        try {
          await fetch(`${baseUrl}/api/rpc`)
          return true
        } catch {
          return false
        }
      },
      60_000
    )
  } catch (error) {
    child.kill("SIGKILL")
    throw error
  }

  return {
    baseUrl,
    aiLogHits: () => aiHits,
    logTail: () => logText,
    kill: async () => {
      child.kill("SIGTERM")
      const { promise, resolve } = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 3000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      await promise
    },
  }
}

// -------------------------------------------------------------------- seed --

/**
 * The storefront read model (Publications) is written at approval — never
 * by an Import Stage — so a populated storefront is something the harness
 * seeds the way an approval would: synthetic approved products with
 * deterministic handles. Deleted again on teardown (KEEP_SEED=1 to keep).
 */
async function seedCatalog(sql: postgres.Sql): Promise<string[]> {
  await sql`DELETE FROM imports WHERE original_filename = 'load-test-seed.csv'`
  const [seed] = (await sql`
    INSERT INTO imports (store_id, content_hash, original_filename, sheet_format,
                         sheet_object_key, family_key, status, stage, sheet_header, row_count)
    VALUES ('default', 'load-test-storefront-seed', 'load-test-seed.csv', 'csv',
            'seed/load-test-seed.csv', 'load-test-seed.csv', 'completed', 'finalise',
            '[]'::jsonb, ${SEED_PRODUCTS})
    RETURNING id`) as Array<{ id: string }>

  const productRows = Array.from({ length: SEED_PRODUCTS }, (_, i) => ({
    key: `sku:load-${String(i).padStart(4, "0")}`,
    title: `Load test item ${i} — demo product`,
    category: i % 2 === 0 ? "Garden" : "Workshop",
    brand: i % 3 === 0 ? "Brunner" : "Nordwind",
  }))
  // Same derivation as the group stage: sha256 of the Natural Key (EC-068).
  const inserted = (await sql`
    INSERT INTO products ${sql(
      productRows.map((p) => ({
        store_id: "default",
        import_id: seed!.id,
        // Same normalization as familyKeyOf: lower(btrim(filename)).
        family_key: "load-test-seed.csv",
        identity_kind: "code",
        natural_key: p.key,
        natural_key_hash: createHash("sha256").update(p.key).digest("hex"),
        title: p.title,
        brand: p.brand,
        category: p.category,
        description: "Seeded load-test product.",
      })),
      "store_id",
      "import_id",
      "family_key",
      "identity_kind",
      "natural_key",
      "natural_key_hash",
      "title",
      "brand",
      "category",
      "description"
    )}
    RETURNING id, natural_key`) as unknown as Array<{
    id: string
    natural_key: string
  }>
  if (inserted.length !== SEED_PRODUCTS) {
    throw new Error(
      `seed inserted ${inserted.length} products, expected ${SEED_PRODUCTS}`
    )
  }

  const keyToId = new Map(inserted.map((p) => [p.natural_key, p.id]))
  // jsonb columns take pre-stringified JSON: a bare JS array would become a
  // postgres array literal, not JSON.
  const publicationRows = productRows.flatMap((p, i) => {
    const productId = keyToId.get(p.key)!
    const handle = `load-item-${String(i).padStart(4, "0")}`
    const base = {
      store_id: "default",
      product_id: productId,
      locale: "en",
      handle,
      title: p.title,
      description: `A sturdy demo product (#${i}) with some copy to render.`,
      category: p.category,
      tags: JSON.stringify(["demo", "load-test"]),
      attributes: JSON.stringify({ colour: "red", size: `${1 + (i % 5)} l` }),
      variants: JSON.stringify([
        {
          sku: `LOAD-${i}-A`,
          gtin: null,
          priceCents: 1299 + i,
          priceCurrency: "EUR",
          attributes: { size: `${1 + (i % 5)} l` },
          imageRef: null,
        },
      ]),
      photos: JSON.stringify(
        i % 4 === 0
          ? [{ objectKey: `seed/photo-${i}.jpg`, filename: `photo-${i}.jpg` }]
          : []
      ),
    }
    const rows = [{ ...base }]
    if (i % 3 === 0) {
      rows.push({ ...base, locale: "de", title: `Lastentest Artikel ${i}` })
    }
    if (i % 5 === 0) {
      rows.push({ ...base, locale: "fr", title: `Article de test ${i}` })
    }
    return rows
  })

  await sql`
    INSERT INTO publications ${sql(
      publicationRows,
      "store_id",
      "product_id",
      "locale",
      "handle",
      "title",
      "description",
      "category",
      "tags",
      "attributes",
      "variants",
      "photos"
    )}`

  console.log(
    `    seeded ${SEED_PRODUCTS} approved products → ${publicationRows.length} publications`
  )
  return productRows.map((_, i) => `load-item-${String(i).padStart(4, "0")}`)
}

async function unseedCatalog(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM imports WHERE original_filename = 'load-test-seed.csv'`
}

// ------------------------------------------------------------------ worker --

interface ImportDto {
  id: string
  status: string
  stage: string
  rowCount: number | null
}

function spawnWorker(): number {
  // Demo Mode env, deterministically keyless: strip provider credentials
  // and chaos knobs so the stub provider runs its deterministic baseline.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (AI_CREDENTIAL_PATTERN.test(key) || key.startsWith("STUB_CHAOS_")) {
      delete env[key]
    }
  }
  const child = spawn(NODE_BIN, ["--import", "tsx", "src/main.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...env,
      ...SERVICE_ENV,
      WORKER_CLAIM_INTERVAL_MS: "100",
      WORKER_HEARTBEAT_INTERVAL_MS: "2000",
      WORKER_LEASE_TTL_MS: "5000",
      WORKER_SWEEP_INTERVAL_MS: "3000",
      WORKER_BATCH_SIZE: "25",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk: Buffer) =>
    process.stdout.write(`[worker] ${chunk}`)
  )
  child.stderr.on("data", (chunk: Buffer) =>
    process.stderr.write(`[worker!] ${chunk}`)
  )
  return child.pid!
}

// -------------------------------------------------------------------- main --

/**
 * Import progress straight from Postgres — status/stage are the source of
 * truth there (GLOSSARY: Work Queue; the Event Stream may lag or drop). The
 * app-facing REST detail surface moved behind the oRPC mount, so polling
 * HTTP here would couple the harness to dashboard API shape for nothing.
 */
async function fetchImport(sql: postgres.Sql, id: string): Promise<ImportDto> {
  const rows = (await sql`
    SELECT id::text, status::text, stage::text,
           row_count AS "rowCount"
    FROM imports WHERE id = ${id}`) as unknown as Array<{
    id: string
    status: string
    stage: string
    rowCount: number | null
  }>
  if (rows.length !== 1) {
    throw new Error(`import ${id} not found in Postgres (${rows.length} rows)`)
  }
  return rows[0]!
}

async function main(): Promise<void> {
  const dbClient = postgres(DATABASE_URL, { max: 4 })
  let app: AppHandle | undefined
  let workerPid: number | undefined
  const tempDir = mkdtempSync(path.join(tmpdir(), "cf-storefront-load-"))
  let report!: LoadReport

  try {
    // Publications (and everything else) must exist before the app serves
    // and the harness seeds the read model.
    console.log(`==> applying pending migrations…`)
    await runMigrations({
      url: DATABASE_URL,
      migrationsFolder: path.resolve(
        import.meta.dirname,
        "../../../core/db/drizzle"
      ),
    })

    console.log(
      `==> generating ${ROWS.toLocaleString("en-US")}-row sheet (seed ${SHEET_SEED})…`
    )
    const csv = toCsv(generateSheet(ROWS, SHEET_SEED))
    const sheetPath = path.join(tempDir, "supplier-10k.csv")
    writeFileSync(sheetPath, csv, "utf8")

    app = await startApp()
    const appUrl = app.baseUrl
    const handles = await seedCatalog(dbClient)
    const collectionUrl = `${appUrl}/storefront`

    console.log(`==> baseline bursts (warm routes, pre-import)…`)
    const baselineCollection = await burst(collectionUrl, BURST_MS, CONNECTIONS)
    const productHandle = handles[0]!
    const baselineProduct = await burst(
      `${appUrl}/storefront/${productHandle}`,
      BURST_MS,
      CONNECTIONS
    )
    console.log(
      `    baseline p95: collection ${baselineCollection.p95Ms}ms, product ${baselineProduct.p95Ms}ms`
    )

    console.log(`==> uploading sheet to ${appUrl}/api/imports…`)
    const uploadAt = Date.now()
    const form = new FormData()
    // Unique filename per run: the family key is the normalized filename
    // (ticket #14), and independent runs must not fold into one family's
    // natural-key space — each run is a fresh 10k import, not a re-import.
    const filename = `supplier-10k-${SHEET_SEED}.csv`
    form.append("sheet", new Blob([csv], { type: "text/csv" }), filename)
    const uploadResponse = await fetch(`${appUrl}/api/imports`, {
      method: "POST",
      body: form,
    })
    if (!uploadResponse.ok) {
      throw new Error(
        `upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`
      )
    }
    const { import: uploaded, deduped } = (await uploadResponse.json()) as {
      import: ImportDto
      deduped?: boolean
    }
    if (deduped) {
      throw new Error(
        `content-hash dedupe hit import ${uploaded.id} — sheet not unique`
      )
    }
    const uploadToAckMs = Date.now() - uploadAt
    console.log(`    import ${uploaded.id} acknowledged in ${uploadToAckMs}ms`)

    console.log(`==> starting keyless Demo Mode worker (stub provider)…`)
    const workerStart = Date.now()
    workerPid = spawnWorker()

    // Churn is real once intake hands off (stage moves past the barrier).
    await waitFor(
      "import to leave intake",
      async () => {
        const imp = await fetchImport(dbClient, uploaded.id)
        return imp.stage !== "intake"
      },
      IMPORT_TIMEOUT_MS
    )

    console.log(
      `==> load phase: simultaneous collection + product autocannon while the import churns…`
    )
    const collectionWindows: BurstResult[] = []
    const productWindows: BurstResult[] = []
    const loadStart = Date.now()
    let windows = 0
    for (;;) {
      const handle = handles[windows % handles.length]!
      const [collectionWindow, productWindow] = await Promise.all([
        burst(collectionUrl, BURST_MS, CONNECTIONS),
        burst(`${appUrl}/storefront/${handle}`, BURST_MS, CONNECTIONS),
      ])
      collectionWindows.push(collectionWindow)
      productWindows.push(productWindow)
      windows += 1
      const imp = await fetchImport(dbClient, uploaded.id)
      const terminal = imp.status === "completed" || imp.status === "failed"
      const capped =
        LOAD_WINDOW_CAP_MS > 0 && Date.now() - loadStart >= LOAD_WINDOW_CAP_MS
      if (terminal || capped) {
        if (capped && !terminal) {
          console.log(
            `    load window cap reached; waiting for import completion (rows/min)…`
          )
          await waitFor(
            "import to complete",
            async () => {
              const current = await fetchImport(dbClient, uploaded.id)
              return (
                current.status === "completed" || current.status === "failed"
              )
            },
            IMPORT_TIMEOUT_MS - (Date.now() - workerStart)
          )
        }
        break
      }
    }
    const loadElapsedMs = Date.now() - loadStart

    const finalImport = await fetchImport(dbClient, uploaded.id)
    const completedAt = Date.now()
    if (workerPid !== undefined) {
      try {
        process.kill(workerPid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    if (finalImport.status !== "completed") {
      throw new Error(
        `import ended as ${finalImport.status}, expected completed`
      )
    }
    const importElapsedMs = completedAt - workerStart
    const rowsPerMinute = Math.round(ROWS / (importElapsedMs / 60_000))

    const collectionLoad = summarizeWindows(collectionWindows)
    const productLoad = summarizeWindows(productWindows)
    const aiHits = app.aiLogHits()

    report = {
      ticket: "21",
      generatedAt: new Date().toISOString(),
      config: {
        sheetRows: ROWS,
        sheetSeed: SHEET_SEED,
        seedProducts: SEED_PRODUCTS,
        connections: CONNECTIONS,
        burstMs: BURST_MS,
        p95BoundMs: P95_BOUND_MS,
        spikeFactor: SPIKE_FACTOR,
      },
      import: {
        id: uploaded.id,
        status: finalImport.status,
        rows: ROWS,
        elapsedMs: importElapsedMs,
        rowsPerMinute,
        uploadToAckMs,
      },
      storefront: {
        collection: {
          baselineP95Ms: baselineCollection.p95Ms,
          ...collectionLoad,
        },
        product: {
          baselineP95Ms: baselineProduct.p95Ms,
          handlesSampled: Math.min(windows, handles.length),
          ...productLoad,
        },
      },
      noAiCalls: {
        keylessEnv:
          "pass — app env carries zero AI provider credentials (Demo Mode), enforced before boot",
        appLogScan:
          aiHits === 0
            ? "pass — 0 provider/enrich/translate lines in app output during the whole run"
            : `FAIL — ${aiHits} provider/enrich/translate lines in app output`,
        designGuarantee:
          "storefront reads Publications only (ADR-0005); every AI call lives behind the Worker's provider port — the only AI-capable process in this run is the Worker's stub",
      },
      bounds: {
        p95WithinBound:
          collectionLoad.worstWindowP95Ms <= P95_BOUND_MS &&
          productLoad.worstWindowP95Ms <= P95_BOUND_MS,
        noImportCoupledSpike:
          collectionLoad.worstWindowP95Ms <=
            SPIKE_FACTOR * collectionLoad.medianWindowP95Ms &&
          productLoad.worstWindowP95Ms <=
            SPIKE_FACTOR * productLoad.medianWindowP95Ms,
        noRouteErrors:
          collectionLoad.errors === 0 &&
          collectionLoad.non2xx === 0 &&
          productLoad.errors === 0 &&
          productLoad.non2xx === 0,
        importCompleted: finalImport.status === "completed",
      },
      pass: false,
    }
    report.pass = Object.values(report.bounds).every(Boolean) && aiHits === 0

    // ------------------------------------------------------------- output --
    const json = JSON.stringify(report, null, 2)
    const md = renderMarkdown(report, {
      windows,
      loadElapsedMs,
      baselineCollection,
      baselineProduct,
    })
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(path.join(OUT_DIR, "load-results.md"), md, "utf8")
    writeFileSync(path.join(OUT_DIR, "load-results.json"), json, "utf8")

    console.log(`\n${md}`)
    console.log(`\nsaved: ${path.join(OUT_DIR, "load-results.md")}`)
    console.log(`saved: ${path.join(OUT_DIR, "load-results.json")}`)

    if (!report.pass) {
      const failed = Object.entries(report.bounds)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
      throw new Error(
        `bounds violated: ${failed.join(", ")}` +
          (app.logTail().length > 0 ? `\napp log tail:\n${app.logTail()}` : "")
      )
    }
    console.log(`STOREFRONT LOAD: PASS`)
  } finally {
    if (app) await app.kill()
    if (workerPid !== undefined) {
      try {
        process.kill(workerPid, "SIGKILL")
      } catch {
        // already gone
      }
    }
    if (process.env.KEEP_SEED === "1") {
      console.log(`KEEP_SEED=1 — leaving seeded publications in place`)
    } else {
      await unseedCatalog(dbClient).catch(() => {})
    }
    rmSync(tempDir, { recursive: true, force: true })
    await dbClient.end()
  }
}

/**
 * Markdown stays readable when the load spans a long import: the first 40
 * windows plus the count; the full array lives in the JSON payload.
 */
function renderWindowList(windows: number[]): string {
  if (windows.length <= 40) return windows.join(", ")
  return `${windows.slice(0, 40).join(", ")} … (${windows.length} windows total; full array in load-results.json)`
}

function renderMarkdown(
  report: LoadReport,
  extra: {
    windows: number
    loadElapsedMs: number
    baselineCollection: BurstResult
    baselineProduct: BurstResult
  }
): string {
  const { storefront, import: imp, bounds } = report
  return `# Storefront p95 under 10k import churn (Ticket 21)

Generated ${report.generatedAt} by \`services/worker/scripts/storefront-load.ts\`.

**Verdict: ${report.pass ? "PASS" : "FAIL"}** — worst-window p95 within ${
    report.config.p95BoundMs
  }ms, no import-coupled spike (≤ ${report.config.spikeFactor}× median window), zero route errors, zero AI calls from the storefront path.

| Metric | Collection \`/storefront\` | Product \`/storefront/[handle]\` |
| --- | --- | --- |
| Baseline p95 (pre-import) | ${storefront.collection.baselineP95Ms} ms | ${storefront.product.baselineP95Ms} ms |
| p95 during import (worst ${report.config.burstMs / 1000}s window) | ${storefront.collection.worstWindowP95Ms} ms | ${storefront.product.worstWindowP95Ms} ms |
| p95 during import (median window) | ${storefront.collection.medianWindowP95Ms} ms | ${storefront.product.medianWindowP95Ms} ms |
| Mean window p95 | ${storefront.collection.meanWindowP95Ms} ms | ${storefront.product.meanWindowP95Ms} ms |
| Requests (all windows, ${report.config.connections} conns) | ${storefront.collection.requests.toLocaleString("en-US")} | ${storefront.product.requests.toLocaleString("en-US")} |
| Errors / non-2xx | ${storefront.collection.errors} / ${storefront.collection.non2xx} | ${storefront.product.errors} / ${storefront.product.non2xx} |

## Import (background churn during the load above)

- Sheet rows: **${imp.rows.toLocaleString("en-US")}** (synthetic fixture, PRNG seed ${report.config.sheetSeed})
- Import \`${imp.id}\` → ${imp.status}
- Worker start → completed: **${(imp.elapsedMs / 1000).toFixed(1)}s**
- Throughput: **${imp.rowsPerMinute.toLocaleString("en-US")} rows/min**
- Load sampled for ${(extra.loadElapsedMs / 1000).toFixed(1)}s across ${
    extra.windows
  } simultaneous collection+product windows

## No AI calls from the storefront

- ${report.noAiCalls.keylessEnv}
- ${report.noAiCalls.appLogScan}
- ${report.noAiCalls.designGuarantee}

## Window-by-window p95 (ms)

- collection: ${renderWindowList(storefront.collection.windowP95sMs)}
- product: ${renderWindowList(storefront.product.windowP95sMs)}

## Bounds

${Object.entries(bounds)
  .map(([name, ok]) => `- ${ok ? "✅" : "❌"} ${name}`)
  .join("\n")}

\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`
`
}

main().catch(async (error: unknown) => {
  console.error(`STOREFRONT LOAD: FAIL —`, error)
  process.exit(1)
})
