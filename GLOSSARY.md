# CatalogForge Glossary

Canonical vocabulary for CatalogForge. Use these terms exactly; don't drift to
synonyms. Implementation choices (which store, which library) live in ADRs,
not here.

## Import & source data

- **Import** — One attempt to turn an uploaded supplier sheet (plus optional
  photos) into catalog products. Identified by the sheet's content: re-uploading
  the same file targets the same Import, never a second one.
- **Sheet Row** — One physical row of the uploaded sheet, recorded exactly as
  the supplier sent it. The immutable unit of source truth; everything derived
  from it can be rebuilt from it.
- **Row Ledger** — The accounting that guarantees every Sheet Row of an Import
  ends in exactly one terminal state: Done, Needs Review, or Failed (with a
  reason). The only source of "the counts add up to the sheet."
- **Product** — The sellable item a group of Sheet Rows collapses into.
- **Variant** — A purchasable form of a Product (one size/colour combination,
  one SKU, one price).
- **Natural Key** — The identity a Product is deduplicated on (scoped so the
  same supplier code from two sources stays two Products).
- **Parked Photo** — An uploaded photo that matched no Product. Surfaced in the
  dashboard with a reason; never silently dropped.
- **Missing-from-Source** — A Variant that existed in the previous Import of a
  sheet family but is absent from the latest one. Never deleted automatically;
  the merchant decides its fate.
- **Fast Path** — The re-import route where only price/weight-like fields
  changed: the change is patched and no enrichment re-runs.
- **Re-run** — A merchant's request to redo a Stage's work for chosen Products
  (e.g. enrichment with different settings). Recorded as a fact the Worker
  adopts, exactly like an Import.

## Pipeline

- **Stage** — A named phase of an Import's processing. Stages run in a fixed
  order; each has one handler and one kind of Batch.
- **Job** — One claimable unit of work: a Stage applied to one Batch. Jobs are
  planned up-front when their Stage begins (plan-then-execute), claimed under a
  Lease, and executed at-least-once; handlers are idempotent so re-runs are
  safe.
- **Batch** — The deterministic slice of rows or products a Job covers.
  Boundaries are computed when the Stage begins, so retries and restarts see
  identical Batches.
- **Barrier Stage** — A Stage whose single Job must observe all rows of the
  Import (e.g. grouping); it fans in everything before it and fans out the
  Batches of the next Stage.
- **Messiness Score** — A per-Product signal computed during cleaning and
  grouping (missing fields, conflicting rows, damaged text, attached photos)
  that decides how strong a model enrichment needs.

## Execution

- **Worker** — The long-lived process that claims Jobs and executes Stage
  handlers. Multiple Workers may run concurrently.
- **Work Queue** — The durable record of Jobs awaiting execution. The single
  source of truth for what work exists and what state it is in.
- **Event Stream** — The append-only feed of progress facts for observers (the
  dashboard). It may lag or drop entries; it is never the source of truth.
- **Lease** — A Worker's time-limited claim on a Job, kept alive by
  heartbeats. An expired Lease is reclaimed and the Job re-run.
- **Pause** — The state entered when a provider throttles us ("resuming in X
  minutes"). Pauses are per provider: one provider throttling holds back that
  provider's Jobs across all Imports; other providers keep working. Imports
  merely surface the Pause for the UI.
- **Demo Mode** — Running the full pipeline with deterministic outputs and no
  AI provider behind it: every guarantee (leases, pauses, resume, ledger) is
  real; only the enrichment brain is absent.

## Review & publication

- **Needs Review** — Terminal quality state meaning "a human must decide,"
  always with a reason. Applies to Products; a Sheet Row whose Product needs
  review mirrors that state in the Row Ledger.
- **Claim** — An assertion extracted from source text (e.g. "frost-resistant").
  Always carries a pointer to the exact source it came from; never invented.
- **Confidence** — Per-field score (0–100) from enrichment; low scores force
  Needs Review.
- **Publication** — The render-ready, per-locale snapshot of an approved
  Product that the storefront reads. Written at approval; the storefront never
  reads staging.
- **Origin** — Who produced a translation: the AI or the merchant. A manual
  Origin always wins over later AI output.
- **Out of Date** — A translation whose English source changed after it was
  made. Kept and flagged; never silently overwritten.

## Boundaries

- **Store** — The isolation boundary for all merchant data. One UI and one
  Store for now, but every record carries its Store from day one.
