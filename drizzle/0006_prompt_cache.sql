CREATE TABLE "visibility_score_prompt_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"n_prompts" integer NOT NULL,
	"prompt_gen_provider" text NOT NULL,
	"prompt_gen_model" text NOT NULL,
	"system_prompt_hash" text NOT NULL,
	"system_prompt" text NOT NULL,
	"user_message" text NOT NULL,
	"prompts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vspc_brand_idx" ON "visibility_score_prompt_cache" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "vspc_lookup_idx" ON "visibility_score_prompt_cache" USING btree ("brand_id","n_prompts","prompt_gen_provider","prompt_gen_model","system_prompt_hash");