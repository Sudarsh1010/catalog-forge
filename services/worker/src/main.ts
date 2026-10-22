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
  type StubChaosOptions,
} from "./provider"
import { defineHandlers } from "./handlers"
import { envFloat, envInt, requireEnv } from "./env"
import { failBatchRows } from "./poison"
import { resolveCacheFromEnv, resolveStorageFromEnv } from "./storage"
import { createWorker } from "./worker"

initLogger(toLoggerConfig(createLogConfig({ service: "worker" })))

const databaseUrl = requireEnv("DATABASE_URL")
const db = createDb({ url: databaseUrl })
const storage = resolveStorageFromEnv()
const cache = resolveCacheFromEnv()

/**
 * Demo Mode: the provider registry is occupied by the deterministic stub —
 * zero API keys. Routing tiers are assigned per Job at plan time from the
 * Messiness Score, but Demo Mode treats tiers identically (spec: Provider
 * handling); real providers register additional entries here without
 * touching the handlers.
 *
 * Chaos flags (Ticket 6) arrive via env — Demo Mode stays deterministic
 * with none set: STUB_CHAOS_FAILURE_RATE, STUB_CHAOS_RATE_LIMIT_AFTER,
 * STUB_CHAOS_RATE_LIMIT_FOR, STUB_CHAOS_RETRY_AFTER_MS,
 * STUB_CHAOS_INVALID_JSON_RATE, STUB_CHAOS_SEED.
 */
const STUB_CONCURRENCY = envInt("WORKER_PROVIDER_CONCURRENCY", 4)
const chaos: StubChaosOptions = {
  ...(process.env.STUB_CHAOS_SEED !== undefined
    ? { seed: envInt("STUB_CHAOS_SEED", 0) }
    : {}),
  ...(process.env.STUB_CHAOS_FAILURE_RATE !== undefined
    ? { failureRate: envFloat("STUB_CHAOS_FAILURE_RATE", 0) }
    : {}),
  ...(process.env.STUB_CHAOS_RATE_LIMIT_AFTER !== undefined
    ? { rateLimitAfter: envInt("STUB_CHAOS_RATE_LIMIT_AFTER", 0) }
    : {}),
  ...(process.env.STUB_CHAOS_RATE_LIMIT_FOR !== undefined
    ? { rateLimitFor: envInt("STUB_CHAOS_RATE_LIMIT_FOR", 0) }
    : {}),
  ...(process.env.STUB_CHAOS_RETRY_AFTER_MS !== undefined
    ? { retryAfterMs: envInt("STUB_CHAOS_RETRY_AFTER_MS", 30_000) }
    : {}),
  ...(process.env.STUB_CHAOS_INVALID_JSON_RATE !== undefined
    ? { invalidJsonRate: envFloat("STUB_CHAOS_INVALID_JSON_RATE", 0) }
    : {}),
}
const providerEntries: ProviderEntry[] = [
  {
    provider: createStubProvider(chaos),
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
  // Poison path: terminal enrich/translate failures land Failed-with-reason
  // in the Row Ledger; the dashboard retry (job_retries) requeues them.
  poisonHandlers: { enrich: failBatchRows, translate: failBatchRows },
  // Loop tunables (env so the kill-the-Worker e2e can shorten the lease
  // TTL and sweep interval) and the backoff policy (EC-082/EC-083).
  config: {
    claimIntervalMs: envInt("WORKER_CLAIM_INTERVAL_MS", 250),
    heartbeatIntervalMs: envInt("WORKER_HEARTBEAT_INTERVAL_MS", 10_000),
    sweepIntervalMs: envInt("WORKER_SWEEP_INTERVAL_MS", 30_000),
    leaseTtlMs: envInt("WORKER_LEASE_TTL_MS", 30_000),
    batchSize: envInt("WORKER_BATCH_SIZE", 5),
    backoffBaseMs: envInt("WORKER_BACKOFF_BASE_MS", 1_000),
    backoffMaxMs: envInt("WORKER_BACKOFF_MAX_MS", 60_000),
  },
  planners: {
    clean: planCleanStage,
    group: planGroupStage,
    "match-media": (planningDb, target) =>
      planMatchMediaStage(planningDb, target, {
        providerForTier: (tier) => registry.providerIdForTier(tier),
      }),
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
