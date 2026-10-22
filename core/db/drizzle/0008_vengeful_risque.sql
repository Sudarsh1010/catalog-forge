CREATE TYPE "public"."pipeline_stage" AS ENUM('intake', 'clean', 'group', 'match-media', 'enrich', 'translate', 'finalise');--> statement-breakpoint
DROP INDEX "sheet_rows_import_idx";--> statement-breakpoint
DROP INDEX "cleaned_rows_import_idx";--> statement-breakpoint
DROP INDEX "products_store_key_idx";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "stage" SET DATA TYPE "public"."pipeline_stage" USING "stage"::"public"."pipeline_stage";--> statement-breakpoint
ALTER TABLE "imports" ALTER COLUMN "stage" SET DEFAULT 'intake'::"public"."pipeline_stage";--> statement-breakpoint
ALTER TABLE "imports" ALTER COLUMN "stage" SET DATA TYPE "public"."pipeline_stage" USING "stage"::"public"."pipeline_stage";--> statement-breakpoint
ALTER TABLE "reruns" ALTER COLUMN "stage" SET DEFAULT 'enrich'::"public"."pipeline_stage";--> statement-breakpoint
ALTER TABLE "reruns" ALTER COLUMN "stage" SET DATA TYPE "public"."pipeline_stage" USING "stage"::"public"."pipeline_stage";--> statement-breakpoint
ALTER TABLE "clean_plans" ADD COLUMN "store_id" text;--> statement-breakpoint
-- Forward-only safety (dev DBs carry e2e data): backfill from the Import
-- before enforcing NOT NULL — a clean plan always belongs to its Import's store.
UPDATE "clean_plans" SET "store_id" = "imports"."store_id" FROM "imports" WHERE "clean_plans"."import_id" = "imports"."id" AND "clean_plans"."store_id" IS NULL;--> statement-breakpoint
ALTER TABLE "clean_plans" ALTER COLUMN "store_id" SET NOT NULL;