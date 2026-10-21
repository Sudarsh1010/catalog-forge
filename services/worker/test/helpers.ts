/**
 * Shared integration-test setup: a throwaway `catalog_forge_test` database
 * so dev data in `catalog_forge` is never clobbered. Recreated from scratch
 * per suite (drop → create → migrate).
 */
import { fileURLToPath } from "node:url"
import path from "node:path"

import { createDb, type Db } from "@workspace/db"
import { runMigrations } from "@workspace/db/migrate"
import { sql } from "drizzle-orm"
import postgres from "postgres"

export const TEST_DB_NAME = "catalog_forge_test"

const devUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"

export function testDatabaseUrl(): string {
  const url = new URL(devUrl)
  url.pathname = `/${TEST_DB_NAME}`
  return url.toString()
}

/** Recreate the test database and apply the shared migrations. */
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

/** Connect the pool under test. Caller must `close()` it. */
export function connectTestDb(): Db {
  return createDb({ url: testDatabaseUrl() })
}

/** Drop the test database (call after all pools are closed). */
export async function dropTestDatabase(): Promise<void> {
  const admin = postgres(devUrl, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

export interface SeedJobOptions {
  stage?: string
  batchKey?: string
  importId?: string
  storeId?: string
  maxAttempts?: number
}

/** Insert one pending Job and return its id. */
export async function seedJob(
  db: Db,
  options: SeedJobOptions = {}
): Promise<string> {
  const rows = await db.db.execute(sql`
    INSERT INTO jobs (store_id, import_id, stage, batch_key, max_attempts)
    VALUES (
      ${options.storeId ?? "test-store"},
      ${options.importId ?? crypto.randomUUID()},
      ${options.stage ?? "demo"},
      ${options.batchKey ?? "batch-1"},
      ${options.maxAttempts ?? 5}
    )
    RETURNING id
  `)
  return (rows as unknown as Array<{ id: string }>)[0]!.id
}

/** Poll a database condition until true or the timeout elapses. */
export async function waitFor(
  message: string,
  check: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
