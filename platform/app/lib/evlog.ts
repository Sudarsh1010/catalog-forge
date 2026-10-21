import { createEvlog } from "evlog/next"
import { createInstrumentation } from "evlog/next/instrumentation/create"
import { toLoggerConfig } from "evlog"

import config from "../evlog.config"

/**
 * The web app's evlog instance — one file, no global state.
 *
 * Route handlers and server actions wrap themselves in `withEvlog` and read
 * the request-scoped logger with `useLogger()`.
 */
export const { withEvlog, useLogger, log, createError } = createEvlog(config)

/** Server-startup and unhandled-error hooks, consumed by instrumentation.ts. */
export const { register, onRequestError } = createInstrumentation({
  ...toLoggerConfig(config),
  captureOutput: true,
})
