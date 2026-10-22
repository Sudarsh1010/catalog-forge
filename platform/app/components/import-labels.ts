/**
 * Shared dashboard vocabulary: the Stage display names and the Import
 * status Badge palettes, so the queue and the detail page never drift.
 * The amber/blue/emerald coding is product-specific, applied via
 * className on the kit Badge — not a kit token.
 */
import type { Stage } from "@workspace/pipeline"

export const STAGE_LABELS: Record<Stage, string> = {
  intake: "Intake",
  clean: "Clean",
  group: "Grouping",
  "match-media": "Photos",
  enrich: "Enrichment",
  translate: "Translation",
  finalise: "Finalising",
}

export const STATUS_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  queued: {
    label: "Queued",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  running: {
    label: "Working",
    className: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  paused: {
    label: "Paused",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  failed: { label: "Failed", className: "bg-destructive/15 text-destructive" },
}
