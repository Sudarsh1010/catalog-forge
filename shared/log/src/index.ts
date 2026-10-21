/**
 * Shared logging surface for every runtime — web frontend, web backend, and
 * the upcoming worker — built on evlog.
 *
 * Import logging from here, not from `evlog` directly, so shared config and
 * defaults apply everywhere and call sites don't churn if the logger changes.
 *
 * - `log` — fire-and-forget structured logs, browser and server.
 * - `createLogger` — wide events for jobs/scripts (call `log.emit()`).
 * - `createError` / `parseError` — structured errors with `why` / `fix`.
 * - `initLogger` / `toLoggerConfig` — bootstrap standalone runtimes (worker).
 *
 * Request-scoped logging in the web app comes from `@/lib/evlog`
 * (`withEvlog` / `useLogger`), which is Next-specific and stays in the app.
 */
export {
  log,
  createLogger,
  createRequestLogger,
  createError,
  parseError,
  initLogger,
  toLoggerConfig,
} from "evlog"

export { createLogConfig } from "./config"
export type { LogConfig, LogConfigInput } from "./config"
