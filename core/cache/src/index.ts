import { Redis } from "ioredis"
import type { Redis as RedisClient } from "ioredis"

export type { RedisClient }

export interface CreateCacheOptions {
  /** Redis connection string, e.g. `redis://:password@host:6379/0`. */
  url: string
  /** Prefix ioredis prepends to every key, e.g. `"catalog-forge:"`. */
  keyPrefix?: string
  /**
   * Defer connecting until the first command. Default: `true`, so creating a
   * cache at module scope never opens a connection nobody uses.
   */
  lazyConnect?: boolean
  /**
   * Retry count per command before failing. Default: 3 (ioredis default).
   * Set `null` when the client also serves queues/subscriptions.
   */
  maxRetriesPerRequest?: number | null
  /** Milliseconds to wait for a connection before failing a command. */
  connectTimeout?: number
}

export interface Cache {
  redis: RedisClient
  /** Gracefully close the connection (`quit`), force-closing if needed. */
  close(): Promise<void>
}

/**
 * Create a Redis cache client.
 *
 * Pure factory: pass the URL in, get a client out. Each runtime (web, worker,
 * scripts) owns its instance and its lifecycle.
 */
export function createCache(options: CreateCacheOptions): Cache {
  const redis = new Redis(options.url, {
    lazyConnect: options.lazyConnect ?? true,
    keyPrefix: options.keyPrefix,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    connectTimeout: options.connectTimeout,
  })

  return {
    redis,
    close: async () => {
      if (redis.status === "end") return
      try {
        await redis.quit()
      } catch {
        // quit() rejects when the connection never opened — force-close.
        redis.disconnect()
      }
    },
  }
}
