/**
 * Worker public surface. `main.ts` is the deployable entrypoint; everything
 * here is importable so integration tests run the same loops in-process.
 */
export { createWorker } from "./worker"
export type { CreateWorkerOptions, WorkerHandle } from "./worker"
export { resolveConfig, DEFAULT_CONFIG } from "./config"
export type { WorkerConfig } from "./config"
export { defineHandlers } from "./handlers"
export type { HandlerRegistry, JobContext, JobHandler } from "./handlers"
export {
  claimJob,
  heartbeatJob,
  completeJob,
  failJob,
  sweepExpiredJobs,
} from "./jobs"
export type { ClaimedJob } from "./jobs"
