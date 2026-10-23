/**
 * Browser oRPC client for ADR-0004 dashboard state (SSE-adjacent live
 * queries). The client talks to the app's RPC endpoint; the upload POST
 * and the SSE EventSource stay raw (streaming, no oRPC envelope).
 *
 * The URL must be absolute in the browser: RPCLink's request encoder does
 * `new URL(url)` with no base, so a relative "/api/rpc" throws
 * `Invalid URL` inside every query — TanStack Query retries it silently
 * and the dashboard never loads (no request ever reaches the network).
 * The server-side copy is never executed (queries don't fetch during
 * SSR), so a relative URL stays fine there.
 */
import { createORPCClient } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import { createTanstackQueryUtils } from "@orpc/tanstack-query"

import type { ClientContract } from "@workspace/contracts"

const rpcUrl =
  typeof window === "undefined"
    ? "/api/rpc"
    : `${window.location.origin}/api/rpc`

const client: ClientContract = createORPCClient(new RPCLink({ url: rpcUrl }))

/** TanStack Query helpers (queryOptions / mutationOptions / keys). */
export const orpc = createTanstackQueryUtils(client)
export { client as orpcClient }
