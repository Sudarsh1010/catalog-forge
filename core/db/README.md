# @workspace/db

Drizzle ORM for Postgres (postgres.js driver), as a pure factory.

## Usage

```ts
import { createDb } from "@workspace/db"

const { db, close } = createDb({ url: process.env.DATABASE_URL })
const rows = await db.query.products.findMany() // relational queries work
await close()
```

- Tables live in `src/schema/` — add one file per domain and re-export it from
  `src/schema/index.ts` (drizzle-kit and `db.query.*` both read that barrel).
- The web app uses the `getDb()` singleton in `platform/app/lib/db.ts`; the
  worker should create its own instance so pool size and lifecycle stay local.

## Scripts (run from `core/db`, need `DATABASE_URL`)

| Script             | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `pnpm db:generate` | Diff schema → write SQL migration to `./drizzle`            |
| `pnpm db:migrate`  | Apply pending migrations (`runMigrations` from `./migrate`) |
| `pnpm db:push`     | Push schema straight to the database (prototyping only)     |
| `pnpm db:studio`   | Open Drizzle Studio                                         |
