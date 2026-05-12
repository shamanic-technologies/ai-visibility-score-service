import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  numeric,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const visibilityScoreRuns = pgTable(
  "visibility_score_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    parentRunId: uuid("parent_run_id"),
    runId: uuid("run_id"),
    domain: text("domain"),
    brandName: text("brand_name"),
    llmProvider: text("llm_provider").notNull(),
    llmModel: text("llm_model").notNull(),
    promptGenModel: text("prompt_gen_model").notNull(),
    extractionProvider: text("extraction_provider").notNull(),
    extractionModel: text("extraction_model").notNull(),
    nPrompts: integer("n_prompts").notNull(),
    weights: jsonb("weights").$type<VisibilityWeights>().notNull(),

    brandMentionCount: integer("brand_mention_count"),
    brandMentionRate: numeric("brand_mention_rate", { precision: 5, scale: 4 }),
    urlMentionCount: integer("url_mention_count"),
    urlMentionRate: numeric("url_mention_rate", { precision: 5, scale: 4 }),
    brandAndUrlCount: integer("brand_and_url_count"),
    brandAndUrlRate: numeric("brand_and_url_rate", { precision: 5, scale: 4 }),
    avgPosition: numeric("avg_position", { precision: 5, scale: 2 }),
    positionScore: numeric("position_score", { precision: 5, scale: 4 }),
    shareOfVoice: numeric("share_of_voice", { precision: 5, scale: 4 }),
    weightedShareOfVoice: numeric("weighted_share_of_voice", { precision: 5, scale: 4 }),
    citationCount: integer("citation_count"),
    citationRate: numeric("citation_rate", { precision: 5, scale: 4 }),
    citationShareOfVoice: numeric("citation_share_of_voice", { precision: 5, scale: 4 }),
    positiveCount: integer("positive_count"),
    neutralCount: integer("neutral_count"),
    negativeCount: integer("negative_count"),
    netSentiment: numeric("net_sentiment", { precision: 5, scale: 4 }),
    avgSentimentScore: numeric("avg_sentiment_score", { precision: 5, scale: 4 }),
    avgResponseLength: integer("avg_response_length"),
    responseLengthWhenBrandFound: integer("response_length_when_brand_found"),
    responseLengthWhenBrandNotFound: integer("response_length_when_brand_not_found"),
    distinctCompetitorsCount: integer("distinct_competitors_count"),
    visibilityScore: numeric("visibility_score", { precision: 5, scale: 4 }),

    status: text("status").notNull().$type<"pending" | "running" | "completed" | "failed">(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vsr_org_id_idx").on(t.orgId),
    index("vsr_brand_id_idx").on(t.brandId),
    index("vsr_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    index("vsr_domain_idx").on(t.domain),
  ],
);

export const visibilityScorePrompts = pgTable(
  "visibility_score_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runIdFk: uuid("run_id_fk")
      .notNull()
      .references(() => visibilityScoreRuns.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    promptIndex: integer("prompt_index").notNull(),
    promptText: text("prompt_text").notNull(),
    responseText: text("response_text").notNull(),
    responseLengthChars: integer("response_length_chars"),
    brandFound: boolean("brand_found"),
    brandCount: integer("brand_count"),
    brandPosition: integer("brand_position"),
    urlFound: boolean("url_found"),
    urlCount: integer("url_count"),
    brandAndUrlCoOccurrence: boolean("brand_and_url_co_occurrence"),
    maxBrandsInResponse: integer("max_brands_in_response"),
    sentiment: text("sentiment"),
    sentimentScore: numeric("sentiment_score", { precision: 5, scale: 4 }),
    citationUrls: text("citation_urls").array(),
    latencyMs: integer("latency_ms"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vsp_run_idx").on(t.runIdFk),
    index("vsp_org_idx").on(t.orgId),
  ],
);

export const visibilityScoreCompetitors = pgTable(
  "visibility_score_competitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runIdFk: uuid("run_id_fk")
      .notNull()
      .references(() => visibilityScoreRuns.id, { onDelete: "cascade" }),
    promptIdFk: uuid("prompt_id_fk")
      .notNull()
      .references(() => visibilityScorePrompts.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull(),
    competitorName: text("competitor_name").notNull(),
    competitorUrl: text("competitor_url"),
    position: integer("position"),
    sentiment: text("sentiment"),
    sentimentScore: numeric("sentiment_score", { precision: 5, scale: 4 }),
    citationUrl: text("citation_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vsc_run_idx").on(t.runIdFk),
    index("vsc_prompt_idx").on(t.promptIdFk),
    index("vsc_org_idx").on(t.orgId),
    index("vsc_run_competitor_idx").on(t.runIdFk, t.competitorName),
  ],
);

export interface VisibilityWeights {
  brandMentionRate: number;
  citationRate: number;
  positionScore: number;
  shareOfVoice: number;
  sentiment: number;
  brandAndUrlRate: number;
}

export type VisibilityScoreRun = typeof visibilityScoreRuns.$inferSelect;
export type NewVisibilityScoreRun = typeof visibilityScoreRuns.$inferInsert;
export type VisibilityScorePrompt = typeof visibilityScorePrompts.$inferSelect;
export type NewVisibilityScorePrompt = typeof visibilityScorePrompts.$inferInsert;
export type VisibilityScoreCompetitor = typeof visibilityScoreCompetitors.$inferSelect;
export type NewVisibilityScoreCompetitor = typeof visibilityScoreCompetitors.$inferInsert;
