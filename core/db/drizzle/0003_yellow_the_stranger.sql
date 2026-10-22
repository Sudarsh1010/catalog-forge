CREATE TYPE "public"."product_identity_kind" AS ENUM('code', 'title');--> statement-breakpoint
CREATE TYPE "public"."row_ledger_state" AS ENUM('done', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."photo_match_strategy" AS ENUM('sku', 'gtin', 'title', 'subfolder');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"identity_kind" "product_identity_kind" NOT NULL,
	"natural_key" text NOT NULL,
	"natural_key_hash" text NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"category" text,
	"description" text,
	"gtin" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_key" text NOT NULL,
	"variant_key_hash" text NOT NULL,
	"sku" text,
	"gtin" text,
	"price_cents" integer,
	"price_currency" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image_ref" text,
	"source_row_index" integer NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "row_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"state" "row_ledger_state" NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"failure_reason" text,
	"failure_ec" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parked_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"ec" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"import_file_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"matched_via" "photo_match_strategy" NOT NULL,
	"matched_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_ledger" ADD CONSTRAINT "row_ledger_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_ledger" ADD CONSTRAINT "row_ledger_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_ledger" ADD CONSTRAINT "row_ledger_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_photos" ADD CONSTRAINT "parked_photos_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parked_photos" ADD CONSTRAINT "parked_photos_import_file_id_import_files_id_fk" FOREIGN KEY ("import_file_id") REFERENCES "public"."import_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_import_file_id_import_files_id_fk" FOREIGN KEY ("import_file_id") REFERENCES "public"."import_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_natural_key_key" ON "products" USING btree ("store_id","import_id","natural_key_hash");--> statement-breakpoint
CREATE INDEX "products_import_idx" ON "products" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "products_store_key_idx" ON "products" USING btree ("store_id","natural_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_identity_key" ON "variants" USING btree ("product_id","variant_key_hash");--> statement-breakpoint
CREATE INDEX "variants_import_idx" ON "variants" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "row_ledger_identity_key" ON "row_ledger" USING btree ("import_id","row_index");--> statement-breakpoint
CREATE INDEX "row_ledger_import_idx" ON "row_ledger" USING btree ("import_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "parked_photos_file_identity_key" ON "parked_photos" USING btree ("import_id","import_file_id");--> statement-breakpoint
CREATE INDEX "parked_photos_import_idx" ON "parked_photos" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_photos_file_identity_key" ON "product_photos" USING btree ("import_id","import_file_id");--> statement-breakpoint
CREATE INDEX "product_photos_product_idx" ON "product_photos" USING btree ("product_id");