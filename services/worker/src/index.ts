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
  requeueJob,
  sweepExpiredJobs,
  rowsOf,
} from "./jobs"
export type { ClaimedJob, RequeueOptions } from "./jobs"
export {
  adoptQueuedImports,
  failImport,
  completeIntake,
  sweepStalledStageAdvances,
} from "./imports"
export { enterProviderPause, resumeExpiredPauses } from "./pause"
export type { ProviderPauseInput, EnteredPause, ResumedPause } from "./pause"
export { failBatchRows, healBatchRows, isBatchStage } from "./poison"
export type { PoisonedJob, PoisonHandler } from "./poison"
export { adoptJobRetries } from "./retries"
export type { AdoptedRetry } from "./retries"
export { adoptReruns } from "./reruns"
export type { AdoptedRerun } from "./reruns"
export { backoffDelayMs } from "./backoff"
export type { BackoffOptions } from "./backoff"
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
export { createGroupHandler, buildProductDrafts } from "./group/handler"
export { GROUP_BATCH_KEY, planGroupStage } from "./group/plan"
export { identityKey, normalizeGtin, keyHash } from "./group/keys"
export { mapColumns } from "./group/columns"
export type { ColumnRoles } from "./group/columns"
export { codeFamilyRelation, familyBase, UnionFind } from "./group/cluster"
export { createMatchMediaHandler } from "./media/handler"
export {
  MEDIA_BATCH_KEY,
  ENRICH_BATCH_SIZE,
  planMatchMediaStage,
} from "./media/plan"
export type { PlanMatchMediaOptions } from "./media/plan"
export { matchPhoto, splitPhotoPath } from "./media/match"
export type {
  MatchableProduct,
  MatchableVariant,
  PhotoMatch,
} from "./media/match"
export { publishImportEvent } from "./events"
export { createIntakeHandler } from "./intake"
export type { IntakeDeps } from "./intake"
export { IntakeError } from "./intake/errors"
export { parseCsvStream } from "./intake/csv"
export type { SheetRowEvent } from "./intake/csv"
export { parseXlsxFile } from "./intake/xlsx"
export { extractPhotoArchive, assertSafeEntryName } from "./intake/zip"
export {
  createProviderRegistry,
  createStubProvider,
  routingTierFor,
  routingTierFrom,
  syntheticCostMicros,
  ProviderError,
  STUB_PROVIDER_ID,
  STUB_MODEL,
  REVIEW_CONFIDENCE_THRESHOLD,
} from "./provider"
export type {
  Provider,
  ProviderEntry,
  ProviderRegistry,
  ProviderUsage,
  ProviderFault,
  EnrichInput,
  EnrichmentResult,
  TranslateInput,
  TranslateResult,
  RoutingTier,
} from "./provider"
export { createEnrichHandler } from "./enrich/handler"
export {
  messinessScore,
  MESSINESS_WEIGHTS,
  MESSINESS_MAX,
  planTimeMessinessSql,
} from "./messiness"
export type { EnrichDeps } from "./enrich/handler"
export { createTranslateHandler } from "./translate/handler"
export type { TranslateDeps } from "./translate/handler"
export { createFinaliseHandler } from "./finalise/handler"
export type { FinaliseDeps } from "./finalise/handler"
export { FINALISE_BATCH_KEY, planFinaliseStage } from "./finalise/plan"
