---
status: accepted
---

# The import pipeline is a fixed stage machine with planned batches, not a generic DAG engine

The pipeline does have fan-out and fan-in, but its topology is static and known
at design time: `intake → clean → group (barrier) → match-media → enrich →
translate → finalise`. We hard-code these as stages with one typed handler
each, instead of building a graph executor the pipeline would be expressed in.

Batches follow **plan-then-execute**: when a stage begins, every Job for that
stage is inserted up front, with batch boundaries computed deterministically
(row-chunks for `clean`, one job for the `group` barrier, product-batches for
`enrich`, product-batch × locale for `translate`). Progress is therefore
countable (`COUNT(*) GROUP BY status`), and a restart re-discovers identical
batches instead of guessing where it left off.

## Consequences

- Stage advancement is decentralized: the last job of a stage advances the
  Import and plans the next stage inside its completion transaction, with a
  periodic sweeper as the self-healing safety net (any import whose stage has
  zero pending/running jobs but hasn't advanced gets advanced).
- Re-running AI on selected products is "requeue stage `enrich` for these
  ids", not a subgraph problem.
- Adding a stage means an enum value + handler + migration. Stages change
  rarely; that friction is the acceptable price of not maintaining an engine.
