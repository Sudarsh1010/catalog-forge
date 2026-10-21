import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"

export interface RunMigrationsOptions {
  url: string
  /**
   * Folder containing the drizzle-kit output. Defaults to `"drizzle"`
   * (cwd-relative), so run from `core/db` or pass an absolute path.
   */
  migrationsFolder?: string
}

/**
 * Apply pending migrations from `core/db/drizzle`.
 *
 * Uses a single dedicated connection (`max: 1`) as recommended for the
 * migrator, and always closes it before returning.
 */
export async function runMigrations(
  options: RunMigrationsOptions
): Promise<void> {
  const client = postgres(options.url, { max: 1 })

  try {
    await migrate(drizzle(client), {
      migrationsFolder: options.migrationsFolder ?? "drizzle",
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}
