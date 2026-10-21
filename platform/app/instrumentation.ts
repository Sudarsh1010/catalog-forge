import { defineNodeInstrumentation } from "evlog/next/instrumentation"

/**
 * Next.js observability hooks. Loads `lib/evlog` on the Node.js runtime only,
 * keeping Node-only code out of the Edge bundle.
 */
export const { register, onRequestError } = defineNodeInstrumentation(
  () => import("./lib/evlog")
)
