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
import { createGroupHandler } from "./group/handler"
import { planGroupStage } from "./group/plan"
import { createMatchMediaHandler } from "./media/handler"
import { planMatchMediaStage } from "./media/plan"
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
 * Pipeline surface through Ticket 4: intake, clean, the group Barrier (with
 * its deterministic enrich/translate fan-out at completion) and match-media.
 * Ticket 5 registers the enrich/translate HANDLERS; their Batches are
 * already planned by the barrier (ADR-0002).
 */
const handlers = defineHandlers({
  intake: createIntakeHandler({
    storage,
    cache,
    planNextStage: planCleanStage,
  }),
  clean: createCleanHandler(),
  group: createGroupHandler(),
  "match-media": createMatchMediaHandler(),
})

const worker = createWorker({
  db,
  handlers,
  cache,
  planners: {
    clean: planCleanStage,
    group: planGroupStage,
    "match-media": planMatchMediaStage,
  },
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
