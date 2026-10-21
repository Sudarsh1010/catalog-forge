# Product

<!-- impeccable:product-schema 1 -->

PRODUCT.md for `packages/ui` (`@workspace/ui`), the shared web UI kit for
CatalogForge. It records the product truth that governs every component in
this package. The app that consumes the kit lives at `platform/app`.

## Platform

web

## Users

- **Merchants (primary).** Receive messy supplier data — spreadsheets in many
  formats, photo folders or zips — and need a clean, translated, store-ready
  catalog without breaking their storefront. German/European file conventions
  (`,` decimals, `;` delimiters, Windows-1252 encodings) are routine, not
  exotic.
- **Shoppers.** Browse the storefront that this same app renders; catalog
  surfaces must stay fast and correct even while large imports run in the
  background.
- **Workspace engineers.** Consume this package from `platform/app` via
  `@workspace/ui/components/*`, `./hooks/*`, `./lib/*`; add components with
  the shadcn CLI.

## Product Purpose

CatalogForge turns a merchant's messy supplier sheet plus a folder of photos
into a clean, translated, store-ready catalog that never breaks the
storefront. Success: the merchant goes from dropped file to trustworthy
published catalog with confidence in every AI-assisted change, and shoppers
never notice an import happening.

## Positioning

Three pillars, confirmed together as the differentiator — a neighboring
spreadsheet-cleanup or PIM tool would have to copy all of them:

1. AI-assisted cleanup and translation of genuinely messy multi-format
   supplier data.
2. Reliability at scale: background imports survive AI failures and server
   restarts, never duplicate products, never slow the storefront.
3. Speed of import: sheet to catalog faster than any alternative.

## Operating Context

- Inputs: `.xlsx`, legacy `.xls`, `.ods`, CSV family (`,`, `;`, tab, `|`
  delimiters), Google Sheets and Numbers exports, `.zip` photo folders;
  encodings from UTF-8 through UTF-16 to Windows-1252; ragged and multi-sheet
  workbooks; files up to 100 MB+. Full failure-mode catalog in
  `edge-cases.md` (stable `EC-###` IDs, P0–P2 priorities).
- Reference scenario (from the brief): a 5,000-row German supplier sheet with
  mixed prices (`1.299,00 €`, `12.5`, `£8`, blank), mixed units (cm/inch,
  kg/lbs), colour typos ("terracota"), HTML in descriptions,
  split/duplicated/out-of-order rows — plus a 10,000-row background import
  that must survive AI failures and server restarts, never duplicate, never
  slow the storefront.
- The storefront is part of this product: cleaned catalogs publish to a
  CatalogForge-rendered storefront, so this kit serves both merchant-facing
  operating screens and shopper-facing catalog surfaces.
- Terminology: merchant, supplier sheet, import, catalog, storefront.

## Capabilities and Constraints

- This package is a **stock shadcn kit and stays one**: close to shadcn
  defaults; distinctiveness is not a goal; consistency and speed of assembly
  govern. Confirmed at init.
- Component layer: shadcn-style registry components built on `@base-ui/react`
  (not Radix), styled with Tailwind CSS 4 tokens defined in
  `src/styles/globals.css`, variants via `class-variance-authority`, icons via
  `@hugeicons/react`, light/dark theming via `next-themes`.
- Components are added with `pnpm dlx shadcn@latest add <component> -c
  platform/app`, landing in `src/components/`. Exports are per-file:
  `./components/*`, `./hooks/*`, `./lib/*`, `./globals.css`,
  `./postcss.config`.
- Backend context the UI sits on: Postgres 18, Redis 8, Garage S3; this
  package has no runtime services of its own.

## Brand Commitments

- Product name: **CatalogForge** (as used in `edge-cases.md` and the repo
  name).
- No logo, voice, palette, or identity assets exist yet; nothing else is
  binding.

## Evidence on Hand

- `edge-cases.md` (repo root): the authoritative product brief so far —
  edge-case catalog with stable IDs and priorities, built around the
  reference scenario above. Source of truth for import/cleanup behavior.
- Repo state: pre-launch. No real merchants, imports, testimonials, metrics,
  screenshots, or product copy exist yet. Future work must not fabricate any
  of these.
- The README at the repo root documents the shadcn monorepo template
  scaffolding, not the product.

## Product Principles

1. Correctness over cleverness: money, units, and product identity (no
   duplicates) are never sacrificed for speed or polish.
2. Show the work: AI-assisted changes are surfaced for review, never silently
   applied; confidence and error recovery are first-class UI states.
3. The storefront is sacred: no merchant-facing flow may degrade the shopper
   experience; background work stays background.
4. Stock on purpose: the kit borrows shadcn conventions so familiarity and
   assembly speed win; product personality lives in the flows, not the
   chrome.
5. Messy input is the norm: every upload and import surface is designed for
   the 5,000-row German sheet, not the clean demo CSV.
