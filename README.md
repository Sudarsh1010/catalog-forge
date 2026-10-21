# shadcn/ui monorepo template

This is a Next.js monorepo template with shadcn/ui.

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

To add components to your app, run the following command at the root of your `web` app:

```bash
pnpm dlx shadcn@latest add button -c platform/app
```

This will place the ui components in the `packages/ui/src/components` directory.

## Using components

To use the components in your app, import them from the `ui` package.

```tsx
import { Button } from "@workspace/ui/components/button"
```
