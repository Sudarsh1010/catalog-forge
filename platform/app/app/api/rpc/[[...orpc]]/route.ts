/**
 * The oRPC mount: one catch-all handler serving every procedure in
 * `appRouter` over the RPC protocol. Clients talk to `/api/rpc/**` (see
 * test/** for the typed-client usage).
 */
import { RPCHandler } from "@orpc/server/fetch"

import { appRouter } from "@/lib/rpc"

const handler = new RPCHandler(appRouter)

async function handle(request: Request): Promise<Response> {
  const { response } = await handler.handle(request, {
    prefix: "/api/rpc",
    context: {},
  })
  return response ?? new Response("Not Found", { status: 404 })
}

export const runtime = "nodejs"

export const HEAD = handle
export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
