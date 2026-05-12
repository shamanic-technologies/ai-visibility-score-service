ALTER TABLE "visibility_score_runs" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "feature_slug" text;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "workflow_slug" text;--> statement-breakpoint
CREATE INDEX "vsr_campaign_id_idx" ON "visibility_score_runs" USING btree ("campaign_id");