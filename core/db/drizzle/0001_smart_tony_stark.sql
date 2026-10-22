CREATE TYPE "public"."import_status" AS ENUM('queued', 'running', 'paused', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_file_kind" AS ENUM('sheet', 'photo', 'photo_zip');--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"original_filename" text NOT NULL,
	"sheet_format" text NOT NULL,
	"sheet_object_key" text NOT NULL,
	"status" "import_status" DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'intake' NOT NULL,
	"sheet_header" jsonb,
	"row_count" integer,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"kind" "import_file_kind" NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_rows" ADD CONSTRAINT "sheet_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imports_content_hash_key" ON "imports" USING btree ("store_id","content_hash");--> statement-breakpoint
CREATE INDEX "imports_adoption_idx" ON "imports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_files_object_key" ON "import_files" USING btree ("import_id","object_key");--> statement-breakpoint
CREATE INDEX "import_files_import_idx" ON "import_files" USING btree ("import_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "sheet_rows_identity_key" ON "sheet_rows" USING btree ("import_id","row_index");--> statement-breakpoint
CREATE INDEX "sheet_rows_import_idx" ON "sheet_rows" USING btree ("import_id","row_index");