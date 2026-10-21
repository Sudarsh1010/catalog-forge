/**
 * The typed Stage-handler registry. Later tickets plug the seven pipeline
 * Stages in here; the claim loop dispatches through this map and knows
 * nothing about what a Stage actually does.
 *
 * Handlers are executed at-least-once (ADR-0003) and MUST therefore be
 * idempotent — upserts keyed by (import, stage, batch), never appends.
 */
import type { Database } from "@workspace/db"
import type { Job } from "@workspace/db/schema"
import { createLogger } from "@workspace/log"

/** Context handed to every handler invocation. */
export interface JobContext {
  job: Job
  db: Database
  /** The worker's structured logger (same type handlers get everywhere). */
  log: ReturnType<typeof createLogger>
}

export type JobHandler = (ctx: JobContext) => Promise<void>

/** Stage name → handler. Typed so a registered stage can't be mis-keyed. */
export type HandlerRegistry = Record<string, JobHandler>

export function defineHandlers<Stages extends string>(
  handlers: Record<Stages, JobHandler>
): HandlerRegistry {
  return handlers
}
