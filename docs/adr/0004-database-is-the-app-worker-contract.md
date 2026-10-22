---
status: accepted
---

# The database is the app↔worker contract

`services/worker` is an independent deployable, and the only contract between
it and `platform/app` is the shared database (plus the Redis progress stream).
The app writes domain facts — Imports, Re-runs, approvals — and reads dashboard
state read-only; the worker's sweeper adopts new Imports and owns all job
machinery (planning, claiming, leasing). One shared Drizzle schema lives in
`core/db` with table-ownership rules: the app writes imports / products /
approvals; the worker writes jobs / ledger / enrichment.

## Considered options

- **A shared enqueue library both services import** — rejected: couples the
  two deployables' release cycles and drags job machinery into the web app.
- **An internal worker HTTP API** — rejected: a surface to secure and retry
  semantics to rebuild, when Postgres already gives us both (the write is the
  queue insert; the sweeper is the retry).

## Consequences

- Read-only SQL across the boundary is accepted at this scale; if the app ever
  needs stronger isolation, views or a replica — not HTTP — are the next step.
