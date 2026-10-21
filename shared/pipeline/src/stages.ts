/**
 * The fixed seven-Stage pipeline (ADR-0002). A text column, not a Postgres
 * enum, so the app/worker contract can evolve without enum migrations — the
 * authoritative list lives here and both deployables import it.
 */
export const PIPELINE_STAGES = [
  "intake",
  "clean",
  "group",
  "match-media",
  "enrich",
  "translate",
  "finalise",
] as const

export type Stage = (typeof PIPELINE_STAGES)[number]

export const FIRST_STAGE: Stage = "intake"

/** The Stage that follows `stage`, or `null` at the end of the pipeline. */
export function nextStage(stage: Stage): Stage | null {
  const index = PIPELINE_STAGES.indexOf(stage)
  if (index === -1) return null
  return PIPELINE_STAGES[index + 1] ?? null
}

export function isStage(value: string): value is Stage {
  return (PIPELINE_STAGES as readonly string[]).includes(value)
}

/** Import lifecycle statuses (the `imports.status` column). */
export const IMPORT_STATUSES = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
] as const

export type ImportStatus = (typeof IMPORT_STATUSES)[number]

/**
 * Single-store UI for v1 (ADR-0006) — every record still carries the store,
 * so the boundary is a constant, not an absence.
 */
export const DEFAULT_STORE_ID = "default"
