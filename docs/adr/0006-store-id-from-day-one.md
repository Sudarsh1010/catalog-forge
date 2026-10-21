---
status: accepted
---

# Every domain table carries store_id from day one, even with a single-store UI

Multi-store is bonus scope and v1 ships one store with no auth. We still put
`store_id` on every domain table now: the column is nearly free while tables
are young, and retrofitting per-store isolation later is a migration festival
(every table, every query, every unique constraint). The single-store UI is a
presentation choice, not a data-model one.

This is deliberate — do not "simplify" it away.
