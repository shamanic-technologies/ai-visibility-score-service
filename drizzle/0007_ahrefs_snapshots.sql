CREATE TABLE IF NOT EXISTS "visibility_ahrefs_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"brand_id" uuid NOT NULL,
	"campaign_id" uuid,
	"feature_slug" text,
	"workflow_slug" text,
	"run_id" uuid,
	"aggregate_run_id" uuid,
	"domain" text NOT NULL,
	"brand_name" text,
	"status" text NOT NULL,
	"error" text,
	"snapshot_date" text,
	"fetched_from_cache" boolean,
	"mentions_total" integer,
	"mentions_by_engine" jsonb,
	"top_competitors" jsonb,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'visibility_ahrefs_snapshots_aggregate_run_id_visibility_score_runs_id_fk'
	) THEN
		ALTER TABLE "visibility_ahrefs_snapshots" ADD CONSTRAINT "visibility_ahrefs_snapshots_aggregate_run_id_visibility_score_runs_id_fk" FOREIGN KEY ("aggregate_run_id") REFERENCES "public"."visibility_score_runs"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vas_org_brand_created_idx" ON "visibility_ahrefs_snapshots" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vas_brand_idx" ON "visibility_ahrefs_snapshots" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vas_domain_idx" ON "visibility_ahrefs_snapshots" USING btree ("domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vas_aggregate_run_id_idx" ON "visibility_ahrefs_snapshots" USING btree ("aggregate_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vas_run_id_idx" ON "visibility_ahrefs_snapshots" USING btree ("run_id");
