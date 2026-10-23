CREATE TABLE "translation_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"locale" text NOT NULL,
	"field" text NOT NULL,
	"source_text_hash" text NOT NULL,
	"text" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "translation_memory_key" ON "translation_memory" USING btree ("store_id","locale","field","source_text_hash");--> statement-breakpoint
CREATE INDEX "translation_memory_store_idx" ON "translation_memory" USING btree ("store_id","locale");