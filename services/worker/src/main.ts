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

import { createIntakeHandler } from "./intake"
import { createCleanHandler } from "./clean/handler"
import { planCleanStage } from "./clean/plan"
import { defineHandlers } from "./handlers"
import { requireEnv } from "./env"
import { resolveCacheFromEnv, resolveStorageFromEnv } from "./storage"
import { createWorker } from "./worker"

initLogger(toLoggerConfig(createLogConfig({ service: "worker" })))

const databaseUrl = requireEnv("DATABASE_URL")
const db = createDb({ url: databaseUrl })
const storage = resolveStorageFromEnv()
const cache = resolveCacheFromEnv()

/**
 * Ticket 3 pipeline surface: the intake and clean Stages. Later tickets
 * register group/match-media/enrich/translate/finalise here (ADR-0002).
 * `planners` carries the plan-then-execute step: entering `clean` plans its
 * row-chunk Jobs in the advancing transaction; entering `group` only flips
 * the stage value until Ticket 4 plugs its barrier planner in.
 */
const handlers = defineHandlers({
  intake: createIntakeHandler({
    storage,
    cache,
    planNextStage: planCleanStage,
  }),
  clean: createCleanHandler(),
})

const worker = createWorker({
  db,
  handlers,
  cache,
  planners: { clean: planCleanStage },
})
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
