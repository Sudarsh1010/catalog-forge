import { defineEvlog } from "evlog"

/** Everything `defineEvlog` accepts, minus what every service must name itself. */
export type LogConfigInput = NonNullable<Parameters<typeof defineEvlog>[0]>

/** A resolved evlog config, ready for `createEvlog` / `toLoggerConfig`. */
export type LogConfig = ReturnType<typeof defineEvlog>

/**
 * Build the evlog config for one service (web, worker, script, ...).
 *
 * This is the single place shared logging defaults live — sampling, redaction
 * and drains added here apply to every runtime. Each service passes its own
 * `service` name and may override anything.
 */
export function createLogConfig(input: LogConfigInput): LogConfig {
  return defineEvlog({
    // Shared defaults for every service. (Nothing opinionated yet — add
    // sampling, redaction and drain defaults here as the app grows.)
    ...input,
  })
}
