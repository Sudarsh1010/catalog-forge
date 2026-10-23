-- Missing-from-Source count per store (ticket review finding): the worker
-- flags variants whose source row disappeared on re-import; this read-only
-- projection surfaces the count for the Metrics tab. Views-only rule
-- (ticket #19): no rollup tables, the base tables stay the truth.
CREATE VIEW "metrics_missing_from_source" AS
SELECT
  "store_id",
  COUNT(*)::int AS "missing_variants"
FROM "variants"
WHERE "missing_from_source"
GROUP BY "store_id";
