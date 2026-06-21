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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const visibilityScoreRuns = pgTable(
  "visibility_score_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id"),
    brandId: uuid("brand_id").notNull(),
    campaignId: uuid("campaign_id"),
    audienceId: uuid("audience_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    parentRunId: uuid("parent_run_id"),
    runId: uuid("run_id"),
    aggregateRunId: uuid("aggregate_run_id").references((): AnyPgColumn => visibilityScoreRuns.id, { onDelete: "cascade" }),
    judgeKind: text("judge_kind").notNull().default("aggregate").$type<"aggregate" | "per_provider">(),
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

    promptGenSystemPrompt: text("prompt_gen_system_prompt"),
    promptGenUserMessage: text("prompt_gen_user_message"),

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
    index("vsr_aggregate_run_id_idx").on(t.aggregateRunId),
    index("vsr_campaign_id_idx").on(t.campaignId),
    index("vsr_audience_id_idx").on(t.audienceId),
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
    judgeSystemPrompt: text("judge_system_prompt"),
    judgeUserMessage: text("judge_user_message"),
    extractorSystemPrompt: text("extractor_system_prompt"),
    extractorUserMessage: text("extractor_user_message"),
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

export const visibilityScorePromptCache = pgTable(
  "visibility_score_prompt_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id").notNull(),
    nPrompts: integer("n_prompts").notNull(),
    promptGenProvider: text("prompt_gen_provider").notNull(),
    promptGenModel: text("prompt_gen_model").notNull(),
    systemPromptHash: text("system_prompt_hash").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    userMessage: text("user_message").notNull(),
    prompts: jsonb("prompts").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("vspc_brand_idx").on(t.brandId),
    index("vspc_lookup_idx").on(
      t.brandId,
      t.nPrompts,
      t.promptGenProvider,
      t.promptGenModel,
      t.systemPromptHash,
    ),
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

/**
 * One row per visibility run, holding the raw Ahrefs Brand-Radar AI-visibility
 * stats for the brand domain at run time. Supplementary to the LLM-measured
 * score — a failed fetch is recorded (status="failed") and never blocks the run.
 * Kept raw + flat for time-series: snapshots mean little alone, the deltas do.
 */
export const visibilityAhrefsSnapshots = pgTable(
  "visibility_ahrefs_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    userId: uuid("user_id"),
    brandId: uuid("brand_id").notNull(),
    campaignId: uuid("campaign_id"),
    audienceId: uuid("audience_id"),
    featureSlug: text("feature_slug"),
    workflowSlug: text("workflow_slug"),
    runId: uuid("run_id"),
    aggregateRunId: uuid("aggregate_run_id").references(() => visibilityScoreRuns.id, {
      onDelete: "cascade",
    }),
    domain: text("domain").notNull(),
    brandName: text("brand_name"),
    status: text("status").notNull().$type<"completed" | "failed">(),
    error: text("error"),
    // Date the Ahrefs data reflects (upstream string, e.g. "2026-06-01"). Distinct from createdAt.
    snapshotDate: text("snapshot_date"),
    fetchedFromCache: boolean("fetched_from_cache"),
    // Global brand mentions across all AI engines.
    mentionsTotal: integer("mentions_total"),
    // Per-AI-engine breakdown: [{ engine, mentions }].
    mentionsByEngine: jsonb("mentions_by_engine").$type<AhrefEngineMention[]>(),
    // Top competitor brands by citation count (global): [{ brand, domain, citations }].
    topCompetitors: jsonb("top_competitors").$type<AhrefTopCompetitor[]>(),
    // Full upstream payload (bronze) — preserve everything for future fields.
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vas_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt),
    index("vas_brand_idx").on(t.brandId),
    index("vas_domain_idx").on(t.domain),
    index("vas_aggregate_run_id_idx").on(t.aggregateRunId),
    index("vas_run_id_idx").on(t.runId),
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

/** One AI search engine's brand-mention count from Ahrefs Brand-Radar. */
export interface AhrefEngineMention {
  engine: string;
  mentions: number;
}

/** A competitor brand cited in Ahrefs Brand-Radar, by global citation count. */
export interface AhrefTopCompetitor {
  brand: string;
  domain: string | null;
  citations: number;
}

export type VisibilityScoreRun = typeof visibilityScoreRuns.$inferSelect;
export type NewVisibilityScoreRun = typeof visibilityScoreRuns.$inferInsert;
export type VisibilityScorePrompt = typeof visibilityScorePrompts.$inferSelect;
export type NewVisibilityScorePrompt = typeof visibilityScorePrompts.$inferInsert;
export type VisibilityScoreCompetitor = typeof visibilityScoreCompetitors.$inferSelect;
export type NewVisibilityScoreCompetitor = typeof visibilityScoreCompetitors.$inferInsert;
export type VisibilityScorePromptCache = typeof visibilityScorePromptCache.$inferSelect;
export type NewVisibilityScorePromptCache = typeof visibilityScorePromptCache.$inferInsert;
export type VisibilityAhrefsSnapshot = typeof visibilityAhrefsSnapshots.$inferSelect;
export type NewVisibilityAhrefsSnapshot = typeof visibilityAhrefsSnapshots.$inferInsert;
