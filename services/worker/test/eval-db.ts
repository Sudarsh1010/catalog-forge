/**
 * Eval scoring setup (scripts/eval-score.ts): a throwaway
 * `catalog_forge_eval` database plus the dev Redis/Garage, mirroring the
 * integration-test helpers but isolated from them so the eval never clobbers
 * dev or test data.
 */
import { fileURLToPath } from "node:url"
import path from "node:path"

import { createDb, type Db } from "@workspace/db"
import { runMigrations } from "@workspace/db/migrate"
import { createCache, type Cache } from "@workspace/cache"
import { createStorage, type Storage } from "@workspace/storage"
import { CACHE_KEY_PREFIX } from "@workspace/pipeline"
import { PutObjectCommand } from "@aws-sdk/client-s3"
import { sql } from "drizzle-orm"
import postgres from "postgres"

const EVAL_DB_NAME = "catalog_forge_eval"
const EVAL_REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/8"

/** The dev Garage bucket; eval objects live under `eval-tests/<uuid>/…`. */
export function evalStorage(): Storage {
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

/** Eval Redis: dedicated DB index; same key prefix as app + worker. */
export function evalCache(): Cache {
  return createCache({
    url: EVAL_REDIS_URL,
    keyPrefix: CACHE_KEY_PREFIX,
    maxRetriesPerRequest: null,
  })
}

export async function putEvalObject(
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

function evalDatabaseUrl(devUrl: string): string {
  const url = new URL(devUrl)
  url.pathname = `/${EVAL_DB_NAME}`
  return url.toString()
}

/** Recreate the eval database and apply the shared migrations. */
export async function createEvalDatabase(devUrl: string): Promise<void> {
  const admin = postgres(devUrl, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${EVAL_DB_NAME} WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE ${EVAL_DB_NAME}`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../core/db/drizzle"
  )
  await runMigrations({ url: evalDatabaseUrl(devUrl), migrationsFolder })
}

/** Connect the pool under evaluation. Caller must `close()` it. */
export function connectEvalDb(devUrl: string): Db {
  return createDb({ url: evalDatabaseUrl(devUrl) })
}

/** Drop the eval database (call after all pools are closed). */
export async function dropEvalDatabase(devUrl: string): Promise<void> {
  const admin = postgres(devUrl, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${EVAL_DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

export interface EvalImport {
  id: string
  storeId: string
  sheetObjectKey: string
}

/**
 * Insert the queued Import the upload route would create (status `queued`,
 * stage `intake` — the Sweeper adopts it).
 */
export async function seedEvalImport(
  db: Db,
  options: { sheetHeader: string[]; originalFilename?: string }
): Promise<EvalImport> {
  const id = crypto.randomUUID()
  const storeId = "eval-store"
  const filename = options.originalFilename ?? "supplier-sheet.csv"
  const sheetObjectKey = `eval-tests/${id}/sheet/${filename}`
  await db.db.execute(sql`
    INSERT INTO imports (
      id, store_id, content_hash, original_filename, sheet_format,
      sheet_object_key, status, stage, sheet_header
    ) VALUES (
      ${id}, ${storeId}, ${crypto.randomUUID().replaceAll("-", "")}, ${filename},
      'csv', ${sheetObjectKey}, 'queued', 'intake',
      ${JSON.stringify(options.sheetHeader)}::jsonb
    )
  `)
  return { id, storeId, sheetObjectKey }
}

/** Insert one import_files row (the photo ZIP). */
export async function seedEvalImportFile(
  db: Db,
  options: {
    importId: string
    storeId: string
    kind: "photo" | "photo_zip"
    objectKey: string
    filename: string
    contentType?: string
    sizeBytes?: number
  }
): Promise<void> {
  await db.db.execute(sql`
    INSERT INTO import_files (id, store_id, import_id, kind, object_key, filename, content_type, size_bytes)
    VALUES (
      ${crypto.randomUUID()}, ${options.storeId}, ${options.importId}, ${options.kind},
      ${options.objectKey}, ${options.filename}, ${options.contentType ?? null},
      ${options.sizeBytes ?? null}
    )
  `)
}
