ALTER TABLE "visibility_score_prompts" ADD COLUMN "judge_system_prompt" text;--> statement-breakpoint
ALTER TABLE "visibility_score_prompts" ADD COLUMN "judge_user_message" text;--> statement-breakpoint
ALTER TABLE "visibility_score_prompts" ADD COLUMN "extractor_system_prompt" text;--> statement-breakpoint
ALTER TABLE "visibility_score_prompts" ADD COLUMN "extractor_user_message" text;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "prompt_gen_system_prompt" text;--> statement-breakpoint
ALTER TABLE "visibility_score_runs" ADD COLUMN "prompt_gen_user_message" text;