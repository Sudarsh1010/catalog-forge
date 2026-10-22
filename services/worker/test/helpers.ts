/**
 * Shared integration-test setup: a throwaway `catalog_forge_test` database
 * so dev data in `catalog_forge` is never clobbered. Recreated from scratch
 * per suite (drop → create → migrate).
 */
import { fileURLToPath } from "node:url"
import path from "node:path"

import { createDb, type Db } from "@workspace/db"
import { runMigrations } from "@workspace/db/migrate"
import { createCache, type Cache } from "@workspace/cache"
import { createStorage, type Storage } from "@workspace/storage"
import { CACHE_KEY_PREFIX, familyKeyOf } from "@workspace/pipeline"
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { sql } from "drizzle-orm"
import postgres from "postgres"

export const TEST_DB_NAME = process.env.CF_TEST_DB_NAME ?? "catalog_forge_test"
export const TEST_REDIS_URL =
  process.env.REDIS_URL ?? "redis://127.0.0.1:6379/9"

const devUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge"

/** The dev Garage bucket; test objects live under `t2-tests/<uuid>/…`. */
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

/** Test Redis: dedicated DB index; same keyPrefix as app + worker. */
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

export async function putTestObject(
  storage: Storage,
  key: string,
  data: Buffer,
  contentType?: string
): Promise<void> {
  await storage.client.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      Body: data,
      ...(contentType ? { ContentType: contentType } : {}),
    })
  )
}

export async function getTestObject(
  storage: Storage,
  key: string
): Promise<Buffer> {
  const result = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.bucket, Key: key })
  )
  return Buffer.from(await result.Body!.transformToByteArray())
}

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

export interface SeedImportOptions {
  storeId?: string
  contentHash?: string
  status?: "queued" | "running" | "completed" | "failed"
  stage?: string
  sheetFormat?: "csv" | "xlsx"
  originalFilename?: string
  /**
   * Sheet lineage for re-import key-diff (ticket #14). Defaults to the
   * normalized original filename; each seeded Import gets a unique default
   * filename so suites that seed several unrelated Imports never
   * accidentally share a family — pass `familyKey` (or the same
   * `originalFilename`) explicitly to test a re-import.
   */
  familyKey?: string
  /** Header cells intake landed (clean tests need column names). */
  sheetHeader?: string[]
}

export interface SeededImport {
  id: string
  storeId: string
  contentHash: string
  sheetObjectKey: string
}

/**
 * Insert one Import row in `status` (default `queued`, i.e. freshly uploaded,
 * awaiting Sweeper adoption). The storage key is unique per test so suites
 * sharing the dev bucket never collide.
 */
export async function seedImport(
  db: Db,
  options: SeedImportOptions = {}
): Promise<SeededImport> {
  const id = crypto.randomUUID()
  const storeId = options.storeId ?? "test-store"
  const contentHash =
    options.contentHash ?? crypto.randomUUID().replaceAll("-", "")
  const originalFilename =
    options.originalFilename ?? `sheet-${id.slice(0, 8)}.csv`
  const sheetObjectKey = `t2-tests/${id}/sheet/${originalFilename}`
  await db.db.execute(sql`
    INSERT INTO imports (
      id, store_id, content_hash, family_key, original_filename,
      sheet_format, sheet_object_key, status, stage, sheet_header
    ) VALUES (
      ${id}, ${storeId}, ${contentHash},
      ${options.familyKey ?? familyKeyOf(originalFilename)},
      ${originalFilename},
      ${options.sheetFormat ?? "csv"}, ${sheetObjectKey},
      ${options.status ?? "queued"}, ${options.stage ?? "intake"},
      ${options.sheetHeader ? JSON.stringify(options.sheetHeader) : null}::jsonb
    )
  `)
  return { id, storeId, contentHash, sheetObjectKey }
}

export interface SeedImportFileOptions {
  importId: string
  storeId?: string
  kind: "sheet" | "photo" | "photo_zip"
  objectKey: string
  filename: string
  contentType?: string
  sizeBytes?: number
}

/** Insert one import_files row (a photo or archive the worker must process). */
export async function seedImportFile(
  db: Db,
  options: SeedImportFileOptions
): Promise<string> {
  const id = crypto.randomUUID()
  await db.db.execute(sql`
    INSERT INTO import_files (id, store_id, import_id, kind, object_key, filename, content_type, size_bytes)
    VALUES (
      ${id}, ${options.storeId ?? "test-store"}, ${options.importId}, ${options.kind},
      ${options.objectKey}, ${options.filename}, ${options.contentType ?? null},
      ${options.sizeBytes ?? null}
    )
  `)
  return id
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
      ${options.stage ?? "enrich"},
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
