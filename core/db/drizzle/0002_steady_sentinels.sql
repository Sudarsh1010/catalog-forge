CREATE TABLE "clean_plans" (
	"import_id" uuid PRIMARY KEY NOT NULL,
	"columns" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleaned_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"values" jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clean_plans" ADD CONSTRAINT "clean_plans_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleaned_rows" ADD CONSTRAINT "cleaned_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cleaned_rows_identity_key" ON "cleaned_rows" USING btree ("import_id","row_index");--> statement-breakpoint
CREATE INDEX "cleaned_rows_import_idx" ON "cleaned_rows" USING btree ("import_id","row_index");--> statement-breakpoint
CREATE INDEX "cleaned_rows_flags_idx" ON "cleaned_rows" USING gin ("flags");