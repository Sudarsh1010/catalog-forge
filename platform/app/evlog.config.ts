import { createLogConfig } from "@workspace/log"

/**
 * evlog config for the web service. The `evlog` CLI (`evlog map`,
 * `evlog logs`) reads this file; the runtime uses it via `lib/evlog.ts`.
 */
export default createLogConfig({
  service: "web",
})
