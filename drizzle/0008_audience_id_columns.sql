ALTER TABLE "visibility_ahrefs_snapshots" ADD COLUMN "audience_id" uuid;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "audience_id" uuid;--> statement-breakpoint
CREATE INDEX "vsr_audience_id_idx" ON "visibility_score_runs" USING btree ("audience_id");