---
status: accepted
---

# Jobs execute at-least-once under leases; every stage handler is idempotent

"Survive restarts, nothing lost, nothing doubled" cannot be bought with
exactly-once delivery: an AI call is not transactional with the database, so a
worker can always die between calling the provider and recording the result.
We accept at-least-once execution instead. A worker claims a Job by taking a
time-limited lease (`lease_expires_at`) and keeps it alive with heartbeats; a
crashed worker's leases expire and its Jobs are reclaimed and re-run. Handlers
are idempotent — upserts keyed by `(import, stage, batch)` / `(product,
locale)` — so re-execution converges instead of duplicating.

Import-level counts ("every row ends Done, Needs Review, or Failed") are
derived from the Row Ledger, never from job bookkeeping: the counts add up to
the sheet by construction. Poison Jobs (5 failed attempts) terminate as
Failed-with-reason in the ledger and stay retryable from the dashboard.

## Consequences

- Every stage handler must be written idempotent from day one; a handler that
  appends instead of upserting is a latent duplicate-data bug.
- Duplicate AI calls after a crash are an accepted cost (bounded by attempt
  count), priced into cost tracking.
