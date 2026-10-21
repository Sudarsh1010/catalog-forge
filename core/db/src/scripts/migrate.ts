import { runMigrations } from "../migrate"

const url = process.env.DATABASE_URL

if (!url) {
  console.error(
    'DATABASE_URL is not set. Export it in your shell (values live in the repo-root .env.example — see README, "Development services") before running migrations.'
  )
  process.exit(1)
}

await runMigrations({ url })
console.log("Migrations applied.")
