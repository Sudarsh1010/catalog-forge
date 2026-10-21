/**
 * Worker entrypoint: the one process running all loops.
 *
 * Standalone runtimes bootstrap logging via initLogger/toLoggerConfig
 * (see @workspace/log). Env comes from the shell — packages never load
 * .env files (repo convention; values in .env.example).
 */
import { createDb } from "@workspace/db"
import { initLogger, toLoggerConfig } from "@workspace/log"

import { createLogConfig } from "@workspace/log/config"

import { defineHandlers } from "./handlers"
import { createWorker } from "./worker"

initLogger(toLoggerConfig(createLogConfig({ service: "worker" })))

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Export it in your shell (values live in the repo-root .env.example) and try again."
  )
}

const db = createDb({ url: databaseUrl })

/**
 * Demo/seed handler: proves claim → heartbeat → complete end to end without
 * any provider. Later tickets register the real pipeline stages here.
 */
const handlers = defineHandlers({
  demo: async ({ job, log }) => {
    log.info(`demo handler running`, { attempts: job.attempts } as Record<
      string,
      unknown
    >)
  },
})

const worker = createWorker({ db, handlers })
worker.start()

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.log(`worker received ${signal}, stopping…`)
  await worker.stop()
  await db.close()
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

console.log(`worker ${worker.workerId} started`)
