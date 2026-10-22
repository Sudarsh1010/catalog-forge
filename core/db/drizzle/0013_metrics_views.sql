ALTER TABLE "provider_usage" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
-- Metrics views (ticket #19) — read-only projections, no rollup tables.
-- Every dashboard metric selects from one of these; the accounting truth
-- stays in the base tables (Row Ledger, provider_usage, product_translations).
CREATE VIEW "metrics_import_rates" AS
SELECT
  "store_id",
  "import_id",
  COUNT(*)::int AS "total_rows",
  COUNT(*) FILTER (WHERE "state" = 'done')::int AS "done_rows",
  COUNT(*) FILTER (WHERE "state" = 'needs_review')::int AS "needs_review_rows",
  COUNT(*) FILTER (WHERE "state" = 'failed')::int AS "failed_rows",
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE "state" = 'done') / NULLIF(COUNT(*), 0),
    2
  ) AS "done_pct",
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE "state" = 'needs_review') / NULLIF(COUNT(*), 0),
    2
  ) AS "needs_review_pct",
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE "state" = 'failed') / NULLIF(COUNT(*), 0),
    2
  ) AS "failed_pct"
FROM "row_ledger"
GROUP BY "store_id", "import_id";--> statement-breakpoint
CREATE VIEW "metrics_model_usage" AS
SELECT
  "store_id",
  "provider_id",
  "model",
  "operation",
  COUNT(*)::int AS "calls",
  SUM("tokens_in")::bigint AS "tokens_in",
  SUM("tokens_out")::bigint AS "tokens_out",
  SUM("cost_micros")::bigint AS "cost_micros"
FROM "provider_usage"
GROUP BY "store_id", "provider_id", "model", "operation";--> statement-breakpoint
CREATE VIEW "metrics_cost_daily" AS
SELECT
  "store_id",
  ("created_at" AT TIME ZONE 'UTC')::date AS "day",
  COUNT(*)::int AS "calls",
  SUM("cost_micros")::bigint AS "cost_micros"
FROM "provider_usage"
GROUP BY "store_id", ("created_at" AT TIME ZONE 'UTC')::date;--> statement-breakpoint
-- Speed: average and slowest wall-clock duration per model/provider,
-- over the calls that carried a duration (schema: provider_usage.duration_ms).
CREATE VIEW "metrics_model_speed" AS
SELECT
  "store_id",
  "provider_id",
  "model",
  "operation",
  COUNT(*)::int AS "calls",
  ROUND(AVG("duration_ms"), 1) AS "avg_duration_ms",
  MAX("duration_ms")::int AS "slowest_duration_ms"
FROM "provider_usage"
WHERE "duration_ms" IS NOT NULL
GROUP BY "store_id", "provider_id", "model", "operation";--> statement-breakpoint
-- Translation coverage per locale. The denominator is every enriched
-- Product × the three enrichable text fields (title, description,
-- category); out_of_date counts carry the Out-of-Date flag (ticket #15).
CREATE VIEW "metrics_translation_coverage" AS
WITH locales("locale") AS (VALUES ('de'), ('fr')),
enriched AS (
  SELECT "store_id", COUNT(*)::int AS "products_enriched"
  FROM "product_enrichments"
  GROUP BY "store_id"
)
SELECT
  "e"."store_id",
  "l"."locale",
  "e"."products_enriched",
  COUNT(DISTINCT "t"."product_id")::int AS "products_translated",
  COUNT("t"."id")::int AS "fields_translated",
  ROUND(
    100.0 * COUNT("t"."id")
      / NULLIF("e"."products_enriched" * 3, 0),
    2
  ) AS "coverage_pct",
  COUNT(*) FILTER (WHERE "t"."out_of_date")::int AS "out_of_date"
FROM locales "l"
CROSS JOIN enriched "e"
LEFT JOIN "product_translations" "t"
  ON "t"."store_id" = "e"."store_id" AND "t"."locale" = "l"."locale"
GROUP BY "e"."store_id", "l"."locale", "e"."products_enriched";--> statement-breakpoint
-- Cheap/strong routing savings: for every call served by a model other than
-- the strong one, what the strong model (gpt-4o, $2.50/$10.00 per 1M tokens
-- — MODEL_PRICES) would have charged at the same token counts, priced with
-- the same integer per-1k µ-price formula as costMicrosFor (ceil per leg).
CREATE VIEW "metrics_routing_savings" AS
SELECT
  "store_id",
  "operation",
  "provider_id",
  "model",
  COUNT(*)::int AS "calls",
  SUM("cost_micros")::bigint AS "actual_cost_micros",
  SUM(
    CEIL("tokens_in" * 2500 / 1000.0) + CEIL("tokens_out" * 10000 / 1000.0)
  )::bigint AS "strong_cost_micros",
  SUM(
    CEIL("tokens_in" * 2500 / 1000.0) + CEIL("tokens_out" * 10000 / 1000.0)
      - "cost_micros"
  )::bigint AS "saved_micros"
FROM "provider_usage"
WHERE "model" <> 'gpt-4o'
GROUP BY "store_id", "operation", "provider_id", "model";
