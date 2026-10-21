import { createDb, type Db } from "@workspace/db"

import { requireEnv } from "./env"

/**
 * App-wide Postgres database.
 *
 * Cached on globalThis so Next.js dev hot-reload reuses one pool instead of
 * opening a new one per reload. postgres.js connects lazily, so importing
 * this module costs nothing until the first query.
 */
const globalForDb = globalThis as unknown as { __catalogForgeDb?: Db }

export function getDb(): Db {
  if (!globalForDb.__catalogForgeDb) {
    globalForDb.__catalogForgeDb = createDb({ url: requireEnv("DATABASE_URL") })
  }

  return globalForDb.__catalogForgeDb
}
