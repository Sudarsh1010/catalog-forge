---
status: accepted
---

# The storefront reads Publications, never staging

The storefront must stay fast while large imports run, and products still under
review must never appear to shoppers. We decided approval writes a Publication:
a denormalized, render-ready, per-locale snapshot of a Product. Storefront
queries touch only Publications — under-review products are invisible *by
construction*, and import-time writes never contend with shopper reads.

## Considered options

- **Live queries over staging tables with status filters** — rejected: cheaper
  to build, but it gambles the "never slow the storefront" promise every time
  an import hammers the same tables a shopper is SELECTing from, and "under
  review" becomes a filter everyone must remember rather than an impossible
  state.

## Consequences

- The exact Publication shape (render-ready JSON per product × locale) is still
  open, but the read-path boundary is fixed: no storefront query may join
  staging tables.
