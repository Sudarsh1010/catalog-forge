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
 * Ticket 2 pipeline surface: the intake Stage. Later tickets register
 * clean/group/match-media/enrich/translate/finalise here (ADR-0002).
 */
const handlers = defineHandlers({
  intake: createIntakeHandler({ storage, cache }),
})

const worker = createWorker({ db, handlers, cache })
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
