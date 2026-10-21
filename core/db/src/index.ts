import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres, { type Sql } from "postgres"

import * as schema from "./schema"

/** Drizzle database with the app schema attached (`db.query.*` works). */
export type Database = PostgresJsDatabase<typeof schema>

/** Raw postgres.js client, for `sql` templates and `LISTEN/NOTIFY`. */
export type DbClient = Sql

export interface CreateDbOptions {
  /** Postgres connection string, e.g. `postgres://user:pass@host:5432/db`. */
  url: string
  /** Max pooled connections. Default: 10 (postgres.js default). */
  max?: number
  /** Seconds before an idle connection is closed. Default: 0 (keep open). */
  idleTimeout?: number
  /** Seconds to wait for a connection attempt before failing. */
  connectTimeout?: number
  /**
   * Enable prepared statements. Leave `true` except behind a pooler such as
   * PgBouncer in transaction mode, which needs `false`.
   */
  prepare?: boolean
  /** TLS: `true` or `"require"` for hosted databases that need it. */
  ssl?: boolean | "require"
}

export interface Db {
  db: Database
  client: DbClient
  /** Gracefully close the connection pool. */
  close(): Promise<void>
}

/**
 * Create a Postgres-backed Drizzle database.
 *
 * Pure factory: pass the URL in, get a pool out. Each runtime (web, worker,
 * scripts) owns its instance so lifecycle and pool size stay in the caller's
 * hands.
 */
export function createDb(options: CreateDbOptions): Db {
  const client = postgres(options.url, {
    max: options.max,
    idle_timeout: options.idleTimeout,
    connect_timeout: options.connectTimeout,
    prepare: options.prepare,
    ssl: options.ssl,
  })

  const db = drizzle(client, { schema })

  return {
    db,
    client,
    close: () => client.end({ timeout: 5 }),
  }
}
