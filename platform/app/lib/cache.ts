import { createCache, type Cache } from "@workspace/cache"

import { requireEnv } from "./env"

/**
 * App-wide Redis cache.
 *
 * Cached on globalThis so Next.js dev hot-reload reuses one connection
 * instead of opening a new one per reload. Created with `lazyConnect`, so
 * importing this module costs nothing until the first command.
 */
const globalForCache = globalThis as unknown as { __catalogForgeCache?: Cache }

export function getCache(): Cache {
  if (!globalForCache.__catalogForgeCache) {
    globalForCache.__catalogForgeCache = createCache({
      url: requireEnv("REDIS_URL"),
      keyPrefix: "catalog-forge:",
    })
  }

  return globalForCache.__catalogForgeCache
}
