/**
 * Shared dashboard vocabulary: the Stage display names and the Import
 * status Badge palettes, so the queue and the detail page never drift.
 * The amber/blue/emerald coding is product-specific, applied via
 * className on the kit Badge — not a kit token.
 */
import type { Stage } from "@workspace/pipeline"
import {
  CONFIDENCE_HIGH_FROM,
  CONFIDENCE_LOW_BELOW,
} from "@workspace/contracts"

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

/** Products-tab review states (the derived status the API computes). */
export const PRODUCT_STATUS_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  approved: {
    label: "Approved",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  needs_review: {
    label: "Needs review",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  ready: {
    label: "Ready",
    className: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
}

/**
 * Confidence colour cut (user story 21): the same boundaries the enrich
 * Stage gates on — below 70 red, 70–89 amber, 90+ green.
 */
export const CONFIDENCE_STYLES = {
  low: "bg-destructive/15 text-destructive",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  high: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
} as const

export type ConfidenceBucket = keyof typeof CONFIDENCE_STYLES

export function confidenceBucket(score: number): ConfidenceBucket {
  if (score < CONFIDENCE_LOW_BELOW) return "low"
  if (score < CONFIDENCE_HIGH_FROM) return "medium"
  return "high"
}

/** Enriched fields with short display names for the compact chip rows. */
export const CONFIDENCE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "title", label: "Title" },
  { key: "handle", label: "Handle" },
  { key: "description", label: "Desc" },
  { key: "category", label: "Cat" },
  { key: "tags", label: "Tags" },
  { key: "attributes", label: "Attrs" },
]
