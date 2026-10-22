ALTER TABLE "imports" ADD COLUMN "family_key" text;--> statement-breakpoint
UPDATE "imports" SET "family_key" = lower(btrim("original_filename"));--> statement-breakpoint
ALTER TABLE "imports" ALTER COLUMN "family_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "family_key" text;--> statement-breakpoint
UPDATE "products" SET "family_key" = (
  SELECT i."family_key" FROM "imports" i WHERE i."id" = "products"."import_id"
);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "family_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "missing_from_source" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "variants" ADD COLUMN "missing_since" timestamp with time zone;--> statement-breakpoint
DROP INDEX "products_natural_key_key";--> statement-breakpoint
CREATE INDEX "imports_family_idx" ON "imports" USING btree ("store_id","family_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_natural_key_family_key" ON "products" USING btree ("store_id","family_key","natural_key_hash");--> statement-breakpoint
CREATE INDEX "variants_missing_idx" ON "variants" USING btree ("store_id","missing_from_source");
