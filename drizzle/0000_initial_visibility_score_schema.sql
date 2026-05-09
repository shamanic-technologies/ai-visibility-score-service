CREATE TABLE "visibility_score_competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id_fk" uuid NOT NULL,
	"prompt_id_fk" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"competitor_name" text NOT NULL,
	"competitor_url" text,
	"position" integer,
	"sentiment" text,
	"sentiment_score" numeric(5, 4),
	"citation_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visibility_score_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id_fk" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"prompt_index" integer NOT NULL,
	"prompt_text" text NOT NULL,
	"response_text" text NOT NULL,
	"response_length_chars" integer,
	"brand_found" boolean,
	"brand_count" integer,
	"brand_position" integer,
	"url_found" boolean,
	"url_count" integer,
	"brand_and_url_co_occurrence" boolean,
	"max_brands_in_response" integer,
	"sentiment" text,
	"sentiment_score" numeric(5, 4),
	"citation_urls" text[],
	"latency_ms" integer,
	"tokens_input" integer,
	"tokens_output" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visibility_score_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"parent_run_id" uuid,
	"run_id" uuid,
	"domain" text NOT NULL,
	"brand_name" text NOT NULL,
	"llm_provider" text NOT NULL,
	"llm_model" text NOT NULL,
	"prompt_gen_model" text NOT NULL,
	"extraction_provider" text NOT NULL,
	"extraction_model" text NOT NULL,
	"n_prompts" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"brand_mention_count" integer,
	"brand_mention_rate" numeric(5, 4),
	"url_mention_count" integer,
	"url_mention_rate" numeric(5, 4),
	"brand_and_url_count" integer,
	"brand_and_url_rate" numeric(5, 4),
	"avg_position" numeric(5, 2),
	"position_score" numeric(5, 4),
	"share_of_voice" numeric(5, 4),
	"weighted_share_of_voice" numeric(5, 4),
	"citation_count" integer,
	"citation_rate" numeric(5, 4),
	"citation_share_of_voice" numeric(5, 4),
	"positive_count" integer,
	"neutral_count" integer,
	"negative_count" integer,
	"net_sentiment" numeric(5, 4),
	"avg_sentiment_score" numeric(5, 4),
	"avg_response_length" integer,
	"response_length_when_brand_found" integer,
	"response_length_when_brand_not_found" integer,
	"distinct_competitors_count" integer,
	"visibility_score" numeric(5, 2),
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visibility_score_competitors" ADD CONSTRAINT "visibility_score_competitors_run_id_fk_visibility_score_runs_id_fk" FOREIGN KEY ("run_id_fk") REFERENCES "public"."visibility_score_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_score_competitors" ADD CONSTRAINT "visibility_score_competitors_prompt_id_fk_visibility_score_prompts_id_fk" FOREIGN KEY ("prompt_id_fk") REFERENCES "public"."visibility_score_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_score_prompts" ADD CONSTRAINT "visibility_score_prompts_run_id_fk_visibility_score_runs_id_fk" FOREIGN KEY ("run_id_fk") REFERENCES "public"."visibility_score_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vsc_run_idx" ON "visibility_score_competitors" USING btree ("run_id_fk");--> statement-breakpoint
CREATE INDEX "vsc_prompt_idx" ON "visibility_score_competitors" USING btree ("prompt_id_fk");--> statement-breakpoint
CREATE INDEX "vsc_org_idx" ON "visibility_score_competitors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "vsc_run_competitor_idx" ON "visibility_score_competitors" USING btree ("run_id_fk","competitor_name");--> statement-breakpoint
CREATE INDEX "vsp_run_idx" ON "visibility_score_prompts" USING btree ("run_id_fk");--> statement-breakpoint
CREATE INDEX "vsp_org_idx" ON "visibility_score_prompts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "vsr_org_id_idx" ON "visibility_score_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "vsr_brand_id_idx" ON "visibility_score_runs" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "vsr_org_brand_created_idx" ON "visibility_score_runs" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE INDEX "vsr_domain_idx" ON "visibility_score_runs" USING btree ("domain");