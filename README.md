# CatalogForge

Turn messy supplier spreadsheets (and photo ZIPs) into a clean, storefront-ready
product catalog. Upload a sheet, watch the pipeline clean, group, enrich, and
translate it; publish; sell.

## Architecture

```
                       ┌──────────────────────────────────────────────┐
 supplier sheet ──►    │  Next.js app (platform/app)                  │
 photo ZIP   ──►       │  dashboard: /imports, /imports/[id]          │
                       │  storefront: /storefront, /storefront/[h]    │
                       └──────┬───────────────────────┬───────────────┘
                              │ oRPC API (ADR-0007)   │ reads Publications
                              ▼                       │ only (ADR-0005)
                    ┌───────────────────┐             │
                    │ Postgres          │◄────────────┘
                    │  Row Ledger,      │
                    │  Work Queue,      │        ┌───────────────────────┐
                    │  Publications      │───────►│ Worker (services/     │
                    └───────────────────┘ claims │ worker): long-lived   │
                    ┌───────────────────┐ Jobs   │ stage machine         │
                    │ Redis (lease/     │◄───────┤ intake → clean →      │
                    │  heartbeat)       │        │ group → enrich →      │
                    └───────────────────┘        │ translate → publish   │
                    ┌───────────────────┐        └──────────┬────────────┘
                    │ Garage (S3) —     │                   │ provider Port
                    │  sheets + photos  │        gpt-4o-mini / gpt-4o (real)
                    └───────────────────┘        deterministic stub (Demo Mode)
```

Core decisions, each with an ADR in `docs/adr/`:

- **Postgres is the durable work queue** (ADR-0001). Redis is an optimization,
  never the source of truth.
- **Fixed stage machine with planned batches** (ADR-0002). Job boundaries are
  computed up-front, so a retry or restart sees the identical batch.
- **At-least-once execution, idempotent handlers** (ADR-0003). Crashes are a
  normal operating mode, not an exception path.
- **The database is the app↔worker contract** (ADR-0004). The app never calls
  the worker; both speak through tables.
- **The storefront reads Publications, never staging data** (ADR-0005). Import
  churn cannot touch the shop — verified by the load test (see `eval/load-results.md`).
- **Store-scoped from day one** (ADR-0006); **contract-first oRPC API** (ADR-0007).

## Setup

Requires Node ≥ 20.9 and pnpm (`pnpm@12` via corepack).

```bash
pnpm install
pnpm services:up        # Docker: Postgres 18, Redis 8, Garage (S3)
cp .env.example platform/app/.env.local
pnpm dev                # app + worker (turbo dev)
```

No Docker? `nix run .#services` runs the identical services via
process-compose. Full details (endpoints, S3 debugging, reset) in the
"Development services" section below and in `.env.example`.

### Demo Mode (no API key)

`OPENAI_API_KEY` is **optional**. Without it the worker runs in Demo Mode: a
deterministic stub provider (`services/worker/src/provider/stub.ts`) answers
enrich/translate calls through the same port the real provider uses, so the
entire pipeline — grouping, dedupe, pricing, units, photos, publishing,
storefront — runs keyless and reproducibly. Nothing else to configure.

### Real AI (optional)

Uncomment `OPENAI_API_KEY` in `platform/app/.env.local` (worker only). The
worker then routes enrich/translate through two-tier OpenAI: **gpt-4o-mini**
for clean rows (Fast Path), **gpt-4o** for messy/photo-heavy rows. The Next.js
app never sees the key — the worker is the only AI-capable process.

```bash
OPENAI_API_KEY=sk-… pnpm dev
```

### Try it

```bash
pnpm dev
# Dashboard:  http://localhost:3000/  → upload eval/supplier-sheet.csv
#             (121 deliberately messy rows: duplicates, split rows, mixed
#              currencies/units/locales, typos, HTML, no-SKU rows, GTIN
#              corruption, phantom photos — see eval/RESULTS.md)
# Storefront: http://localhost:3000/storefront
```

## Screenshots

Captured from a Demo Mode run over the committed Eval Set sheet
(`eval/supplier-sheet.csv`, 121 rows → 42 products):

| What | Where | Screenshot |
| --- | --- | --- |
| Dashboard — pipeline detail | `/imports/[id]` | ![import-detail](docs/screenshots/dashboard-import-detail.png) |
| Storefront collection (German) | `/storefront?country=DE` | ![storefront](docs/screenshots/storefront-collection.png) |
| Storefront product (German) | `/storefront/[handle]?country=DE` | ![storefront-product](docs/screenshots/storefront-product.png) |

The import-list and needs-review views are pending a client-query fix —
see Known issues in `docs/WRITEUP.md`.

## Tech stack

- **TypeScript everywhere**, pnpm + Turborepo monorepo; oxlint/oxfmt.
- **Next.js** app (dashboard + storefront), shadcn/ui components.
- **Postgres** — row ledger, work queue, publications, read models.
- **Redis** — leases and heartbeats for worker coordination.
- **Garage** (S3-compatible) — supplier sheets and photo originals.
- **BullMQ-style job semantics implemented on Postgres** — planned batches,
  leases, exponential backoff, poison-job handling (`services/worker/src/`).
- **oRPC** contract-first API between app and worker (ADR-0007).

## Design decisions worth knowing

- **Sheet Rows are immutable.** Everything derived can be rebuilt; the Row
  Ledger guarantees every row ends in exactly one terminal state (Done /
  Needs Review / Failed-with-reason) — "the counts add up to the sheet."
- **Duplicate protection via re-import family key-diff** (ticket #14). A
  re-uploaded sheet targets the same Import; grouping diffs the family's
  natural keys `(store, family, natural-key hash)` against the living catalog,
  so re-runs patch instead of duplicating. Missing-from-Source variants are
  never deleted automatically — the merchant decides.
- **Fast Path re-imports.** When only price/weight-like fields changed, the
  change is patched and no AI enrichment re-runs.
- **Messiness Score routes the model.** Score ≥ 50 → gpt-4o (strong tier);
  below → gpt-4o-mini (Fast tier). Routing is stamped on the Job at plan time.
- **Confidence gates review.** Enrichment below 70 confidence flags Needs
  Review — the same gate for the stub and the real provider.
- **Enrichment is grounded.** Tags and Claims must trace to the product's
  source Sheet Rows; claims must cite a `sourceRowIndex` (graded in eval Layer 2).

## Scale strategy

- **Durable queue, not in-memory**: jobs are rows; a worker crash loses
  nothing. Leases expire, another worker re-claims, handlers are idempotent
  (ADR-0003).
- **Retries with backoff** per provider fault class (`src/backoff.ts`,
  `src/retries.ts`): rate-limited (honors `Retry-After`), timeout, server
  error; malformed provider output is a retryable provider fault, never bad data.
- **Restarts are boring**: planned batches mean a resumed job redoes exactly
  one batch; poison jobs are quarantined (`src/poison.ts`) instead of blocking
  the stage.
- **Parallel workers**: any number of workers claim from the same queue;
  barrier stages (e.g. grouping) fan in rows and fan out the next stage's
  batches.
- **Measured** (10,000-row import with 20-connection storefront load running
  against it, `eval/load-results.md`): **2,038 rows/min** single worker,
  import completed in 294 s, storefront p95 stayed within bounds (collection
  676 ms worst window, 0 errors in 25,625 requests).

## Cost optimisation strategy

Three levers, in order of impact:

1. **Two-tier routing.** Most rows are clean; gpt-4o-mini handles them
   (150 µ$/1k in, 600 µ$/1k out). Only high-Messiness rows escalate to gpt-4o
   (2,500/10,000 µ$/1k). The tier is decided from the Messiness Score before
   any call is made.
2. **Translation memory (TM) cache.** Translation calls key on
   `sha256(source text)` per `(store, locale, field)`; identical strings
   across products and re-imports cost zero (`src/translate/handler.ts`).
3. **Fast Path.** Price/weight-only re-imports skip enrichment entirely.

**Cost per 1,000 products (estimated, no live keyed run exists yet).** Real
per-token prices are in `MODEL_PRICES` (`src/provider/port.ts`); without a
live Layer 2 run we have no measured tokens-per-product, so the formula is:

```
cost per 1,000 products ≈ 1,000 × (tokensIn × priceIn + tokensOut × priceOut) / 1e6
```

For a representative enrich call of ~1k input / ~300 output tokens through
gpt-4o-mini that is ≈ **$0.33 per 1,000 products** (estimated). Escalating
~20 % of rows to gpt-4o raises it to ≈ **$7 per 1,000** (estimated); the
routing threshold is what keeps that share small. Numbers marked *estimated*
are derived from MODEL_PRICES + assumed token counts, not from a recorded run.

## Eval

```bash
pnpm --filter @workspace/worker eval:l1   # Layer 1, keyless, deterministic
OPENAI_API_KEY=sk-… pnpm --filter @workspace/worker eval:l2   # AI-field accuracy
```

Layer 1 baseline over the 121-row eval sheet (39 gold products): grouping
92.3 %, dedupe 94.9 %, price 95.9 %, units 99.0 %, photo matching 82.9 %,
review status 87.2 % — see `eval/RESULTS.md`. `eval/thresholds.json` enforces
these as CI floors. Layer 2 grading rules are wired and unit-tested; live
gpt-4o-mini/gpt-4o numbers are pending a keyed run (same doc, "PENDING KEY").

The technical write-up — hardest part, accuracy/invention prevention, measured
numbers, what breaks at 1M products × 8 languages, lessons, AI usage — lives in
[`docs/WRITEUP.md`](docs/WRITEUP.md).

## Development services

Local Postgres, Redis, and S3-compatible object storage (**Garage** — MinIO
was archived upstream in Feb 2026 and removed from nixpkgs). Two
interchangeable ways to run them; both serve identical endpoints and
credentials. Run one or the other, not both at once (they share ports).

| Service     | Endpoint                                                      |
| ----------- | ------------------------------------------------------------- |
| Postgres 18 | `postgresql://postgres:postgres@127.0.0.1:5432/catalog_forge` |
| Redis 8     | `redis://127.0.0.1:6379`                                      |
| Garage (S3) | `http://127.0.0.1:9000` (creds in `.env.example`)             |

### Docker

```bash
pnpm services:up      # up --wait, then provision S3 bucket + dev key (idempotent)
pnpm services:down    # stop (keeps data in named volumes)
pnpm services:reset   # stop and delete volumes
pnpm services:logs    # follow logs
```

### Nix (no docker)

```bash
nix run .#services              # process-compose TUI with all services
nix run .#services -- --tui=false # headless / CI
rm -rf .data                   # full reset (all service data lives here)
```

### Wiring it into the app

```bash
cp .env.example platform/app/.env.local   # Next.js loads env files from the app dir
```

Debugging the S3 side:

```bash
nix shell nixpkgs#awscli2
AWS_ACCESS_KEY_ID=GK0123456789abcdef01234567 \
AWS_SECRET_ACCESS_KEY=941431a5c0f40a678c1ecf010982a2a23f9536ada8d3893cd0641d78ac6cf53c \
  aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://catalog-forge
```

`psql`, `redis-cli`, and the `garage` CLI are available inside the nix dev
shell (`garage -c .data/garage/garage.toml status` for the nix variant, or
`docker compose exec garage /garage -c /etc/garage/garage.toml status` for
docker).

## Adding components

```bash
pnpm dlx shadcn@latest add button -c platform/app
```

This will place the ui components in the `packages/ui/src/components` directory.

```tsx
import { Button } from "@workspace/ui/components/button"
```
