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
  rowsOf,
} from "./jobs"
export type { ClaimedJob } from "./jobs"
export {
  adoptQueuedImports,
  failImport,
  completeIntake,
  sweepStalledStageAdvances,
} from "./imports"
export type {
  StagePlanTarget,
  StagePlanner,
  StagePlannerRegistry,
} from "./stages"
export {
  planCleanStage,
  parseBatchKey,
  batchKey,
  CLEAN_CHUNK_SIZE,
} from "./clean/plan"
export type { PlanCleanOptions, CleanStageTarget } from "./clean/plan"
export { createCleanHandler } from "./clean/handler"
export { publishImportEvent } from "./events"
export { createIntakeHandler } from "./intake"
export type { IntakeDeps } from "./intake"
export { IntakeError } from "./intake/errors"
export { parseCsvStream } from "./intake/csv"
export type { SheetRowEvent } from "./intake/csv"
export { parseXlsxFile } from "./intake/xlsx"
export { extractPhotoArchive, assertSafeEntryName } from "./intake/zip"
