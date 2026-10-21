/**
 * App route-test harness: a throwaway `catalog_forge_test_app` database
 * (Ticket 1 convention, app-suffixed so worker and app suites can run in
 * parallel under turbo), a dedicated Redis DB index, and a real `next dev`
 * server so routes are exercised through plain HTTP — the web seam.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { PassThrough } from "node:stream"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createDb, type Db } from "@workspace/db"
import { runMigrations } from "@workspace/db/migrate"
import { createCache, type Cache } from "@workspace/cache"
import { CACHE_KEY_PREFIX } from "@workspace/pipeline"
import { createStorage, type Storage } from "@workspace/storage"
import Yazl from "yazl"
import { sql } from "drizzle-orm"
import postgres from "postgres"

export const TEST_DB_NAME = "catalog_forge_test_app"
export const TEST_REDIS_URL =
  process.env.REDIS_URL ?? "redis://127.0.0.1:6379/10"

const devUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"

export function testDatabaseUrl(): string {
  const url = new URL(devUrl)
  url.pathname = `/${TEST_DB_NAME}`
  return url.toString()
}

export async function createTestDatabase(): Promise<void> {
  const admin = postgres(devUrl, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../core/db/drizzle"
  )
  await runMigrations({ url: testDatabaseUrl(), migrationsFolder })
}

export function connectTestDb(): Db {
  return createDb({ url: testDatabaseUrl() })
}

export async function dropTestDatabase(): Promise<void> {
  const admin = postgres(devUrl, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

export function testStorage(): Storage {
  return createStorage({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "catalog-forge",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "GK0123456789abcdef01234567",
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ??
      "941431a5c0f40a678c1ecf010982a2a23f9536ada8d3893cd0641d78ac6cf53c",
    forcePathStyle: true,
  })
}

export function testCache(): Cache {
  return createCache({
    url: TEST_REDIS_URL,
    keyPrefix: CACHE_KEY_PREFIX,
    maxRetriesPerRequest: null,
  })
}

export async function flushTestRedis(): Promise<void> {
  const cache = testCache()
  try {
    await cache.redis.flushdb()
  } finally {
    await cache.close()
  }
}

export interface TestApp {
  baseUrl: string
  close(): Promise<void>
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address !== "object" || !("port" in address)) {
    throw new Error("could not determine a free port")
  }
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Boot `next dev` with the test environment; wait until it serves. */
export async function startTestApp(): Promise<TestApp> {
  const port = await freePort()
  const appDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  )
  // Spawn the Next binary directly (not via pnpm) so SIGTERM reaches the
  // actual dev server instead of orphaning it.
  const nextBin = require.resolve("next/dist/bin/next", { paths: [appDir] })
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "dev", "--port", String(port)],
    {
      cwd: appDir,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
        DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: TEST_REDIS_URL,
        S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
        S3_REGION: process.env.S3_REGION ?? "us-east-1",
        S3_BUCKET: process.env.S3_BUCKET ?? "catalog-forge",
        S3_ACCESS_KEY_ID:
          process.env.S3_ACCESS_KEY_ID ?? "GK0123456789abcdef01234567",
        S3_SECRET_ACCESS_KEY:
          process.env.S3_SECRET_ACCESS_KEY ??
          "941431a5c0f40a678c1ecf010982a2a23f9536ada8d3893cd0641d78ac6cf53c",
        S3_FORCE_PATH_STYLE: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[next dev] ${chunk}`)
  })

  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`next dev exited early with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/imports`)
      if (response.ok || response.status === 500) break
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL")
      throw new Error("next dev did not become ready in time")
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return {
    baseUrl,
    close: async () => {
      child.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 5_000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

export async function truncateTables(db: Db): Promise<void> {
  await db.db.execute(
    sql`TRUNCATE jobs, imports, sheet_rows, import_files, cleaned_rows, clean_plans`
  )
}

/** Poll until `check` returns truthy. */
export async function waitFor(
  message: string,
  check: () => Promise<boolean>,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// -------------------------------------------------------------- fixtures --

export function csvBytes(rows: string[][]): Buffer {
  const quote = (cell: string): string =>
    /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
  return Buffer.from(
    rows.map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n",
    "utf8"
  )
}

/** Buffer as an uploadable Blob (DOM BlobPart wants a plain ArrayBufferView). */
export function blob(bytes: Buffer, type: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type })
}

/** Corrupt a ZIP by slicing bytes off the end (breaks the central directory). */
export function truncate(buffer: Buffer, keepBytes: number): Buffer {
  return buffer.subarray(0, Math.max(0, keepBytes))
}

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
)

export { PNG_BYTES }

/** Build a real ZIP via yazl (photos archives, truncated variants). */
export async function buildZip(
  entries: Array<{ name: string; data: Buffer | string }>
): Promise<Buffer> {
  const zipfile = new Yazl.ZipFile()
  for (const entry of entries) {
    zipfile.addBuffer(
      Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data, "utf8"),
      entry.name
    )
  }
  const chunks: Buffer[] = []
  const passthrough = new PassThrough()
  passthrough.on("data", (chunk: Buffer) => chunks.push(chunk))
  const { promise: done, resolve } = Promise.withResolvers<void>()
  passthrough.on("end", resolve)
  zipfile.outputStream.pipe(passthrough)
  zipfile.end()
  await done
  return Buffer.concat(chunks)
}
