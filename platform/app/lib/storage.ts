/**
 * App-wide S3 client for upload streaming. Cached on globalThis so Next.js
 * dev hot-reload reuses one client. Environment values live in
 * platform/app/.env.local (copied from the root .env.example).
 */
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
