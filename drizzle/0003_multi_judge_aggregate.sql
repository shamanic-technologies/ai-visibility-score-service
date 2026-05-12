ALTER TABLE "visibility_score_runs" ADD COLUMN "aggregate_run_id" uuid;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "judge_kind" text DEFAULT 'aggregate' NOT NULL;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD CONSTRAINT "visibility_score_runs_aggregate_run_id_visibility_score_runs_id_fk" FOREIGN KEY ("aggregate_run_id") REFERENCES "public"."visibility_score_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vsr_aggregate_run_id_idx" ON "visibility_score_runs" USING btree ("aggregate_run_id");