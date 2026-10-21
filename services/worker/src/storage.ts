/**
 * Storage access for the Worker runtime: env-driven client plus the stream
 * helpers intake needs (download as stream, download to temp file, stream
 * upload, incremental hashing). Node runtime throughout — S3 bodies are
 * Node Readables here.
 */
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { GetObjectCommand } from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import type { Cache } from "@workspace/cache"
import { CACHE_KEY_PREFIX } from "@workspace/pipeline"
import { createStorage, type Storage } from "@workspace/storage"
import { createCache } from "@workspace/cache"

import { requireEnv } from "./env"

/** The Worker's S3 client, resolved from the shell environment. */
export function resolveStorageFromEnv(): Storage {
  return createStorage({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: requireEnv("S3_REGION"),
    bucket: requireEnv("S3_BUCKET"),
    accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  })
}

/** The Worker's Redis client for event publishing (same keyPrefix as the app). */
export function resolveCacheFromEnv(): Cache {
  return createCache({
    url: requireEnv("REDIS_URL"),
    keyPrefix: CACHE_KEY_PREFIX,
    maxRetriesPerRequest: null,
  })
}

/**
 * The SDK hands back a `SdkStream` that is a Node Readable in the Node
 * runtime (the only runtime the Worker ships in). Narrowed at the boundary
 * so a surprising body fails loudly instead of hanging.
 */
export function bodyToReadable(body: unknown): Readable {
  if (
    body &&
    typeof body === "object" &&
    "pipe" in body &&
    typeof (body as Readable).pipe === "function"
  ) {
    return body as Readable
  }
  throw new Error("S3 response body is not a Node stream (unexpected runtime)")
}

/** Download an object as a stream — never whole-file-in-memory (EC-008). */
export async function downloadObject(
  storage: Storage,
  key: string
): Promise<Readable> {
  const result = await storage.client.send(
    new GetObjectCommand({ Bucket: storage.bucket, Key: key })
  )
  return bodyToReadable(result.Body)
}

/** Stream-hash any readable to a hex sha256. */
export async function hashStream(readable: Readable): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of readable) {
    hash.update(chunk as Buffer)
  }
  return hash.digest("hex")
}

/** Upload a stream with lib-storage: multipart for unknown lengths. */
export async function uploadStream(
  storage: Storage,
  key: string,
  body: Readable,
  contentType?: string
): Promise<void> {
  const upload = new Upload({
    client: storage.client,
    params: {
      Bucket: storage.bucket,
      Key: key,
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    },
    leavePartsOnError: false,
  })
  await upload.done()
}

export interface TempFileDownload {
  /** Directory holding the file — remove with rm(…, { recursive: true }). */
  dir: string
  filePath: string
}

/** Download an object to a fresh temp dir (random-access readers like yauzl). */
export async function downloadToTempFile(
  storage: Storage,
  key: string
): Promise<TempFileDownload> {
  const dir = await mkdtemp(path.join(tmpdir(), "cf-intake-"))
  const filePath = path.join(dir, "download.bin")
  const body = await downloadObject(storage, key)
  try {
    await pipeline(body, createWriteStream(filePath))
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, filePath }
}

/** Read a local file back as a stream (test fixtures, temp downloads). */
export function readFileStream(filePath: string): Readable {
  return createReadStream(filePath)
}
