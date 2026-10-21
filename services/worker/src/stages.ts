/**
 * Stage-planner registry (ADR-0002 plan-then-execute): each Stage owns a
 * planner that inserts ALL of its Jobs up front when the Import enters it.
 * Planners run inside the completion transaction that flips the Import's
 * stage, so a crash can never strand an Import mid-transition with work
 * unplanned — the sweeper stays a pure safety net.
 *
 * A Stage without a registered planner still advances the stage value; its
 * ticket plugs the planner in later (clean did exactly that for group).
 */
import type { Database } from "@workspace/db"

export interface StagePlanTarget {
  importId: string
  storeId: string
}

export type StagePlanner = (
  db: Database,
  target: StagePlanTarget
) => Promise<void>

/** Stage name → the planner that runs when the Import ENTERS that stage. */
export type StagePlannerRegistry = Record<string, StagePlanner>
