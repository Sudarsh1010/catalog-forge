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
import { createEnrichHandler } from "./enrich/handler"
import { createTranslateHandler } from "./translate/handler"
import { createFinaliseHandler } from "./finalise/handler"
import { planFinaliseStage } from "./finalise/plan"
import {
  createProviderRegistry,
  createStubProvider,
  type ProviderEntry,
} from "./provider"
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
 * Demo Mode: the provider registry is occupied by the deterministic stub —
 * zero API keys. Routing tiers are assigned per call from the Messiness
 * Score, but Demo Mode treats tiers identically (spec: Provider handling);
 * real providers register additional entries here without touching the
 * handlers. Chaos flags arrive with Ticket 6's stub on the same port.
 */
const STUB_CONCURRENCY = 4
const providerEntries: ProviderEntry[] = [
  {
    provider: createStubProvider(),
    concurrency: STUB_CONCURRENCY,
    tiers: ["fast", "strong"],
  },
]
const registry = createProviderRegistry(providerEntries)

/** The full seven-Stage pipeline, one typed handler each. */
const handlers = defineHandlers({
  intake: createIntakeHandler({
    storage,
    cache,
    planNextStage: planCleanStage,
  }),
  clean: createCleanHandler(),
  group: createGroupHandler(),
  "match-media": createMatchMediaHandler(),
  enrich: createEnrichHandler({ registry }),
  translate: createTranslateHandler({ registry }),
  finalise: createFinaliseHandler({ cache }),
})

const worker = createWorker({
  db,
  handlers,
  cache,
  planners: {
    clean: planCleanStage,
    group: planGroupStage,
    "match-media": planMatchMediaStage,
    finalise: planFinaliseStage,
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
