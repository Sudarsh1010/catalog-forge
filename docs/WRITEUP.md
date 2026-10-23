# CatalogForge — Technical Write-up

Companion to the [README](../README.md). Every number in this document cites
the artifact it came from; derived numbers are explicitly labelled
_estimated_. Nothing else is invented.

## The hardest part

Grouping — collapsing a messy sheet into **Products and Variants that match
what a human would say** — was the hardest part, and the eval proves it.
Everything downstream of a correct grouping (enrichment, translation,
publishing) is mechanical; upstream of it, the sheet is adversarial.

The 121-row eval sheet (`eval/supplier-sheet.csv`, hand-verified gold labels
in `eval/gold-labels.json`) is full of traps aimed exactly at grouping:

- exact and near-duplicates where the **richer copy must win** (EC-061);
- **conflicting duplicates** — `KB-50-A` at 29,99 vs 27,99 (rows 6–7);
- **split rows** — `Wand-Uhr`/`Wanduhr` (rows 13–14), `Hochbeet` given in
  cm/m/plain (rows 71–73);
- the **over-merge trap** — `SL-2` vs `SL-4` (2-pack vs 4-pack) and
  `SOFA-2A` vs `SOFA-3` must NOT merge even though titles look similar
  (EC-062).

The solution shape (`services/worker/src/group/handler.ts`): a Union-Find over
rows, joined by a **code family relation** (same code ⇒ same product,
title-corroborated), with a fallback chain — coded rows cluster by family
base, code-less split rows join their bucket's single code family, fully
code-less rows group by title+brand (EC-031). Product identity is a
**Natural Key scoped to the sheet family**, so the same supplier code from two
sources stays two products.

It is also the only stage that has to be right in one shot: enrichment errors
are per-field and reviewable; a wrong merge silently fuses two sellable items.

## Extraction accuracy — and preventing invention

Two layers, two different problems.

**Layer 1 (deterministic pipeline, Demo Mode)** — baseline over the 39 gold
products / 49 variants (`eval/RESULTS.md`):

| Field                      | Exact-match accuracy |
| -------------------------- | -------------------- |
| Grouping (rows → Products) | **92.3 %** (36/39)   |
| Dedupe (variant count)     | **94.9 %** (37/39)   |
| Price cents + currency     | **95.9 %** (47/49)   |
| Canonical units (mm/g/ml)  | **99.0 %** (98/99)   |
| Photo matching             | **82.9 %** (29/35)   |
| Review status              | **87.2 %** (34/39)   |

Every known miss in that table is a named pipeline gap, not a random error —
e.g. `KB-50`/`KB-50-A` colour titles defeat the family union, a leading-zero
stripped GTIN doesn't normalize onto its family key, German `100.000 ml`
isn't parsed as a volume. `eval/thresholds.json` pins these numbers as CI
floors; any regression fails the PR.

**Layer 2 (AI fields)** — invention prevention is a _grading rule_, not a
prompt plea. The scorer (`services/worker/scripts/eval-score-l2.ts`) enforces:

- **Tags must be grounded**: every tag traces to the product's source Sheet
  Rows (token coverage ≥ 0.6); an invented tag is an error.
- **Claims must be traceable** (EC-075): every predicted claim must cite a
  `sourceRowIndex` inside the product's `sourceRows` AND its text must be
  grounded in that row's cells. A traceability failure is an **ERROR, never
  partially credited** — that's the strictest rule in the grader, on purpose.
- Title/category are graded loosely (normalized token F1 ≥ 0.6; fuzzy
  containment against the sheet's own `Kategorie`), because valid output
  varies.

The claim-source pointer is the mechanism in production too: the model is
asked to cite `sourceRowIndex`, and the grader (and the unit suite
`test/eval-l2.test.ts`, plus the integration suite with an injected fake
provider) treats an unresolvable pointer — row outside `sourceRows`, text not
grounded in the cited row — as a hard failure.

**Layer 2 status: PENDING KEY.** No `OPENAI_API_KEY` existed in the recording
environment, so there are no live gpt-4o-mini/gpt-4o accuracy numbers yet.
The script refuses to run keyless (a keyless "Layer 2" number would be Demo
Mode wearing a false label). Recording one: `OPENAI_API_KEY=sk-… pnpm --filter @workspace/worker eval:l2`.

## Measured numbers

All from committed artifacts.

**Throughput** (`eval/load-results.md`, 10,000-row import, single worker):
**2,038 rows/min**, import completed in 294.4 s.

**Storefront under import churn** (same run, 20 concurrent connections, 57
simultaneous collection+product windows, 25,625 requests total):

| Metric                               | Collection `/storefront` | Product `/storefront/[handle]` |
| ------------------------------------ | ------------------------ | ------------------------------ |
| Baseline p95                         | 475.3 ms                 | 95.7 ms                        |
| p95 during import (worst 5 s window) | **676 ms**               | **899.3 ms**                   |
| p95 during import (median window)    | 599.7 ms                 | 696 ms                         |
| Errors / non-2xx                     | 0 / 0                    | 0 / 0                          |

Verdict PASS: worst-window p95 within the 1250 ms bound, no import-coupled
spike (≤ 5× median window), zero errors — and **zero AI calls from the
storefront path**, enforced structurally: the app env is keyless (checked
before boot), and the storefront reads Publications only (ADR-0005). The
worker is the only AI-capable process in the system.

**Layer 1 accuracy**: the table above (`eval/RESULTS.md`).

**Layer 2**: wired, unit-tested, gated on a key — no live numbers yet
("PENDING KEY" note in `eval/RESULTS.md`).

**Cost per 1,000 products — _estimated_, derived, not measured.** Real prices
live in `MODEL_PRICES` (`services/worker/src/provider/port.ts`): gpt-4o-mini
**150 µ$/1k in, 600 µ$/1k out**; gpt-4o **2,500/10,000 µ$/1k**. With no keyed
run there is no measured tokens-per-product, so using a representative ~1k
in / ~300 out token enrich call:

- all-mini: 1000 × (1000×150µ$ + 300×600µ$) ≈ **$0.33 per 1,000 products** _(estimated)_
- if 20 % of rows escalate to gpt-4o: ≈ **$7 per 1,000** _(estimated)_

The mitigation for the second number is per-row two-tier routing (the
photo-aware Messiness Score sends each enrich call to the cheap or strong
tier), which keeps the escalated share small, plus the TM cache — which now
also covers identity no-ops — and the Fast Path (README, "Cost optimisation
strategy").

## What breaks at 1,000,000 products in 8 languages — and the fix

The architecture holds longer than you'd expect, then breaks in three places:

1. **Barrier stages and single-worker throughput.** At 2,038 rows/min
   (measured, single worker), a 1M-row sheet takes ~8 h per worker.
   _Fix (already designed for):_ batches are planned up-front (ADR-0002), so
   scaling is `kubectl scale worker --replicas=N` — the queue parallelizes
   cleanly and handlers are idempotent (ADR-0003). Barrier stages (grouping)
   are the serial bottleneck; they'd need intra-stage sharding by family key.

2. **Translation cost and latency.** Naïvely, enrichment+translation is
   per-product × per-locale × per-field: 1M products × 8 locales × ~3 fields
   ≈ 24M model calls at current throughput. _Fix (implemented):_ the
   **translation memory** keys on `sha256(source text)` per
   (store, locale, field) — supplier catalogs repeat copy massively
   (variants share titles/descriptions), and re-imports hit the cache for
   free; identity no-ops (unchanged source text) are written to the TM too,
   so identical text on another product is served from cache with zero
   provider calls. Combined with **two-tier routing** (per enrich-time row:
   gpt-4o-mini for clean rows, gpt-4o — with the row's actual photo image
   content, not just a note — for messy/photo rows) and the **Fast Path**
   (price-only re-imports skip enrichment entirely; a fully unchanged
   re-upload is a true no-op), the paid-call count drops to unique-text ×
   tier, not products × locales × fields.

3. **Publication read models and the storefront.** 1M products × 8 locales
   means the publications read model (ADR-0005) grows to ~8M locale rows and
   hot collection pages span deep indexes. _Fix:_ publications are already a
   denormalized, storefront-only read model — partition by store, keep
   per-collection materialized lists, and the storefront never touches
   staging so import churn stays invisible (proven at 10k; the read model is
   designed to be rebuilt from Sheet Rows at any time).

Net: the durable-queue + read-model architecture is the fix for (1) and (3);
only grouping needs real engineering work to go horizontal, and the TM cache
is what makes (2) financially survivable.

## Lessons

- **An eval set before a pipeline.** The 121-row sheet with hand-verified
  gold labels (`eval/gold-labels.json`) caught every grouping gap listed in
  `eval/RESULTS.md` before a merchant would have; CI floors
  (`eval/thresholds.json`) keep the wins from silently rotting.
- **Immutability buys restartability.** Because Sheet Rows are immutable and
  batches are planned up-front, "worker crashed mid-import" is a non-event —
  leases expire, another worker re-claims, handlers are idempotent.
- **Separate truth from observation.** The Event Stream can lag or drop;
  the Row Ledger cannot. Building the dashboard on a lossy stream kept the
  queue simple and honest.
- **Grounding must be enforced, not requested.** Prompting the model to cite
  sources is not invention prevention; grading citations against
  `sourceRows` (and unit-testing the grader's failure modes) is.
- **Keylessness is a feature.** Demo Mode through the same provider port made
  the whole system testable in CI for free — and made "Layer 2 without a key"
  impossible to fake, because the harness refuses.

## How AI was used while building

This project was built with AI coding agents end-to-end — architecture
decisions were captured as ADRs (`docs/adr/0001`–`0007`) and a canonical
glossary (`GLOSSARY.md`) precisely so agents (and humans) couldn't drift:
the tickets, ADRs, and glossary are the specification the agents implemented
against. AI wrote the bulk of the pipeline, app, eval harness, and load
harness; humans set the gold labels by hand, decided the grading rules, and
reviewed every measured claim in this document. Fittingly, the product's own
discipline — grounded, source-citable output — is the discipline that made
agent-built code trustworthy here.

## Known issues

- **FIXED — browser-bundle oRPC queries never fired** (found and fixed
  2026-10-23): in a real Chromium tab, TanStack Query calls through the
  browser oRPC client stayed `isPending` forever on `/` and `/products`.
  Three root causes, all fixed:
  1. The browser `RPCLink` was built from a **relative base URL** — oRPC's
     encoder does `new URL(baseUrl)`, which throws in a browser, so no client
     request was ever issued. It is now absolute
     (`window.location.origin`).
  2. `/` and `/products` were **statically prerendered**, baking the pending
     shell into the HTML. Both are now `force-dynamic` RSC pages that
     server-render the import queue and the products table (rows appear in
     the SSR HTML); interactions are URL state plus server actions passed as
     props.
  3. Server actions were being **imported into client bundles**, tripping a
     Turbopack fast-refresh loop. They are no longer imported client-side.
     The dashboard edit flow's requeue was also made ADR-0004-clean in the same
     pass: editing a product writes a `reruns` fact (stage `translate`) that the
     worker's sweeper adopts — the requeue SQL lives in one shared worker helper
     using the exported batch-key patterns (this also fixed a latent bug where
     rerun adoption didn't match translate batch keys carrying a `:locale`
     suffix). Two behavior fixes landed alongside: re-import no longer clears
     Needs-Review (a product's Needs-Review flag is sticky — re-import can only
     set it; a variant's flag is sheet-owned, so a conflicting price sets it and
     a resolving sheet clears it; an unchanged re-upload is a true no-op with no
     `updated_at` churn), and the server-rendered `/products` tab gained bulk
     **Send back** next to Approve — one `reruns` fact per import carries all
     chosen ids. Coverage at fix time: worker suite 26 files / 155 tests, web
     suite 8 files / 76 tests, `eval:l1` exit 0. An in-browser smoke test
     remains a worthwhile follow-up.
- **0010 migration on mid-window dev databases**: if your dev DB predates the
  0010 migration patch, re-apply the patch (or `pnpm services:reset`) before
  running the worker.
- **Layer 2 + cost-per-1,000 measured numbers pending an `OPENAI_API_KEY`**;
  the scripts (`pnpm --filter @workspace/worker eval:l2`) are wired and
  verified against an injected fake provider. No key exists in any
  environment, so routing/vision behavior is verified by tests, not by
  measured live numbers.
