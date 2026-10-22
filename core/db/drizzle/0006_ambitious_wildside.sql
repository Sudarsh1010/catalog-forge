CREATE TABLE "provider_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"reason" text NOT NULL,
	"resume_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_retries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" text NOT NULL,
	"import_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "routing_tier" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "paused_provider_id" text;--> statement-breakpoint
ALTER TABLE "job_retries" ADD CONSTRAINT "job_retries_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_retries" ADD CONSTRAINT "job_retries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_pauses_identity_key" ON "provider_pauses" USING btree ("store_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_pauses_resume_idx" ON "provider_pauses" USING btree ("resume_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_retries_job_key" ON "job_retries" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_retries_adoption_idx" ON "job_retries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_provider_idx" ON "jobs" USING btree ("provider_id");