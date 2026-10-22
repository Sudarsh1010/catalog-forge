CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_cents" integer,
	"price_currency" text,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_product_locale_key" ON "publications" USING btree ("product_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "publications_handle_key" ON "publications" USING btree ("store_id","locale","handle");--> statement-breakpoint
CREATE INDEX "publications_store_locale_idx" ON "publications" USING btree ("store_id","locale");