/**
 * Browser oRPC client for ADR-0004 read-only dashboard state. The client
 * talks to the app's RPC endpoint; the upload POST and the SSE EventSource
 * stay raw (streaming, no oRPC envelope).
 */
import { createORPCClient } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import { createTanstackQueryUtils } from "@orpc/tanstack-query"

import type { ClientContract } from "@workspace/contracts"

const client: ClientContract = createORPCClient(
  new RPCLink({ url: "/api/rpc" })
)

/** TanStack Query helpers (queryOptions / mutationOptions / keys). */
export const orpc = createTanstackQueryUtils(client)
export { client as orpcClient }
