import { createInstrumentation } from "evlog/next/instrumentation/create"
import { toLoggerConfig } from "evlog"

import config from "../evlog.config"

/**
 * The web app's evlog instance — one file, no global state. Only the
 * instrumentation hooks are consumed (`instrumentation.ts`): server-startup
 * and unhandled-error hooks on the Node.js runtime.
 */
export const { register, onRequestError } = createInstrumentation({
  ...toLoggerConfig(config),
  captureOutput: true,
})
