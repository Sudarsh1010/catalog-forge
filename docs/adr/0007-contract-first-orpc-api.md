---
status: accepted
---

# The API is contract-first oRPC in a single web app

There is one web surface: `platform/app` (the Next.js app, package `web`).
The separate admin Vite app (`platform/admin`) is deleted; any admin routes
live inside `platform/app` like everything else. The browser talks to the app
through a contract-first oRPC API: the contracts (procedures and their input/
output types) live in `shared/contracts` as `@workspace/contracts`, the server
implements them in `platform/app`, and the browser consumes them through
TanStack Query. Both sides share the same TypeScript types, so the
browser↔app surface is typed end-to-end without hand-written clients.

## Context

Maintaining two frontend apps (Next.js + Vite) meant duplicated auth, styling,
build, and deployment for no benefit at this scale — the admin app existed
mostly for historical reasons. At the same time, the app's JSON API had grown
by accretion: routes with hand-maintained request/response shapes, and a
client that parsed those shapes independently, so drift between the two was
only caught at runtime.

## Decision

- **Single web app.** Admin folds into `platform/app`; `platform/admin` is
  removed. One deployable, one auth story, one styling system (the
  `@workspace/ui` shadcn kit).
- **Contract-first oRPC** on the stable v1 line. Contracts are defined in
  `@workspace/contracts` and are the single source of truth: the server
  implements against them, the browser client derives its typed calls from
  them. No parallel hand-written client SDK.
- **Streaming endpoints stay plain route handlers.** Multipart upload
  (`POST /api/imports`, streaming through busboy for 100MB+ files) and SSE
  (`GET /api/imports/[id]/events`, with `Last-Event-ID` resume) remain regular
  Next.js route handlers, not oRPC procedures. oRPC's multipart handling is
  unsuitable for large streamed uploads (a maintainer-confirmed upstream
  limitation), and SSE is a response stream, not a request/response call —
  forcing either into an RPC shape would fight the framework.
- **TanStack Query owns client server-state.** Components read and mutate
  through the query cache; the SSE stream is an event source that writes
  progress updates into the cache rather than into component-local state.

## Relationship to ADR-0004

ADR-0004 (the database is the app↔worker contract) is unchanged. This ADR
governs only the browser↔app surface; nothing here moves data across the
app↔worker boundary.

## Consequences

- Adding or changing an API shape is one edit in `@workspace/contracts`, with
  compile-time errors on both sides for any drift.
- Route-handler and oRPC code coexist in `platform/app`; the split rule is
  streaming (upload, SSE) vs request/response, and it is deliberate, not
  transitional.
- Deleting `platform/admin` removes a build/deploy target; admin work now
  ships with the main app's release cadence.
