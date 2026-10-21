---
status: accepted
---

# Postgres is the durable work queue; Redis Streams is only a lossy progress feed

Imports must survive worker crashes and server restarts with nothing lost or
doubled, and the stack already runs Postgres and Redis. We decided that Postgres
— a `jobs` table claimed with `SELECT … FOR UPDATE SKIP LOCKED` — is the single
source of truth for what work exists. Redis Streams carries only the live
progress feed for the dashboard (SSE): dropped or lagging entries are
acceptable there because the UI rebuilds from a Postgres snapshot and tails the
stream from its last-seen ID.

## Considered options

- **Redis Streams consumer groups as the work queue** — rejected: durability
  then depends on Redis persistence and stream retention; "resume after
  restart" becomes _trust the stream_ instead of _read a table_. At our scale
  (10k rows per import) Postgres is nowhere near its limit.
- **Both as queues** — rejected: two sources of truth for the same jobs means
  dual-write reconciliation, which is exactly how work gets lost or doubled.
- **A queue library (BullMQ, pg-boss)** — rejected: our pause/backoff semantics
  are provider-aware (per-provider throttling) and import-scoped; a hand-rolled
  claim loop over `SKIP LOCKED` is small and fully ours. Revisit if job shapes
  grow more exotic than "stage over batch".
