# @workspace/log

Shared logging (evlog) for every runtime: web frontend, web backend, worker.

Import logging from `@workspace/log`, not from `evlog` directly.

## Usage

```ts
import { log, createLogger, createError, parseError } from "@workspace/log"

log.info("cache", "warmed") // simple logs, browser + server
const job = createLogger({ jobId: 42 }) // wide event for a job/script
job.set({ processed: 10 })
job.emit()
throw createError({ message: "x", status: 400, why: "...", fix: "..." })
const { why, fix } = parseError(err) // client components
```

- Per-service config: `createLogConfig({ service: "worker" })` (the web app
  does this in `platform/app/evlog.config.ts`). Shared sampling/redaction/drain
  defaults belong in `src/config.ts`.
- Request-scoped logging in the web app (`withEvlog` / `useLogger`) is
  Next-specific and lives in `platform/app/lib/evlog.ts`.
- A future worker bootstraps with:
  `initLogger(toLoggerConfig(createLogConfig({ service: "worker" })))`.
