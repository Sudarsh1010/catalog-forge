CREATE TYPE "public"."enrichment_status" AS ENUM('ready', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."provider_operation" AS ENUM('enrich', 'translate');--> statement-breakpoint
CREATE TYPE "public"."translation_origin" AS ENUM('ai', 'manual');--> statement-breakpoint
CREATE TABLE "product_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"title" text NOT NULL,
	"handle" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" jsonb NOT NULL,
	"status" "enrichment_status" NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_row_indexes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"field" text NOT NULL,
	"text" text NOT NULL,
	"source_text_hash" text NOT NULL,
	"origin" "translation_origin" DEFAULT 'ai' NOT NULL,
	"out_of_date" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"product_id" uuid,
	"operation" "provider_operation" NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_micros" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_enrichments" ADD CONSTRAINT "product_enrichments_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_enrichments" ADD CONSTRAINT "product_enrichments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_translations" ADD CONSTRAINT "product_translations_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_translations" ADD CONSTRAINT "product_translations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_enrichments_product_key" ON "product_enrichments" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_enrichments_import_idx" ON "product_enrichments" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_translations_field_key" ON "product_translations" USING btree ("product_id","locale","field");--> statement-breakpoint
CREATE INDEX "product_translations_import_idx" ON "product_translations" USING btree ("import_id","locale");--> statement-breakpoint
CREATE INDEX "provider_usage_import_idx" ON "provider_usage" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "provider_usage_product_idx" ON "provider_usage" USING btree ("product_id");