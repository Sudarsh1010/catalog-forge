/**
 * App-wide S3 client for upload streaming. Cached on globalThis so Next.js
 * dev hot-reload reuses one client. Environment values live in
 * platform/app/.env.local (copied from the root .env.example).
 */
import { GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { Storage } from "@workspace/storage"
import { createStorage } from "@workspace/storage"

import { requireEnv } from "./env"

const globalForStorage = globalThis as unknown as {
  __catalogForgeStorage?: Storage
}

export function getStorage(): Storage {
  if (!globalForStorage.__catalogForgeStorage) {
    globalForStorage.__catalogForgeStorage = createStorage({
      endpoint: requireEnv("S3_ENDPOINT"),
      region: requireEnv("S3_REGION"),
      bucket: requireEnv("S3_BUCKET"),
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    })
  }
  return globalForStorage.__catalogForgeStorage
}

/**
 * A short-lived GET URL for one stored object — how the storefront renders
 * Publication photos without a public bucket (ADR-0005: render-ready reads,
 * no staging access).
 */
export async function presignDownload(objectKey: string): Promise<string> {
  const storage = getStorage()
  return getSignedUrl(
    storage.client,
    new GetObjectCommand({ Bucket: storage.bucket, Key: objectKey }),
    { expiresIn: 3600 }
  )
}
