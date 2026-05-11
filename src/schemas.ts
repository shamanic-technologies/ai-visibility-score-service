import { z } from "zod";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const orgScopedHeaders = {
  "x-api-key": z.string().openapi({ description: "Service-to-service API key" }),
  "x-org-id": z.string().uuid().openapi({ description: "Internal org UUID" }),
  "x-user-id": z.string().optional().openapi({ description: "Internal user UUID" }),
  "x-run-id": z.string().uuid().optional().openapi({
    description: "Caller's run ID — captured as parentRunId when this service creates its own run",
  }),
  "x-brand-id": z.string().optional().openapi({
    description: "Comma-separated brand UUID(s). Required for /orgs/visibility-score-runs.",
  }),
  "x-campaign-id": z.string().optional(),
  "x-feature-slug": z.string().optional(),
  "x-workflow-slug": z.string().optional(),
};

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

export const ValidationErrorResponseSchema = z
  .object({ error: z.string(), details: z.record(z.string(), z.unknown()).optional() })
  .openapi("ValidationErrorResponse");

export const HealthResponseSchema = z
  .object({ status: z.literal("ok"), service: z.literal("ai-visibility-score-service") })
  .openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Liveness check",
  responses: {
    200: { description: "OK", content: { "application/json": { schema: HealthResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  tags: ["Docs"],
  summary: "OpenAPI specification",
  responses: {
    200: { description: "Spec", content: { "application/json": { schema: z.object({}).passthrough() } } },
    404: { description: "Spec not generated", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const VisibilityWeightsSchema = z
  .object({
    brandMentionRate: z.number().min(0).max(1),
    citationRate: z.number().min(0).max(1),
    positionScore: z.number().min(0).max(1),
    shareOfVoice: z.number().min(0).max(1),
    sentiment: z.number().min(0).max(1),
    brandAndUrlRate: z.number().min(0).max(1),
  })
  .openapi("VisibilityWeights");

export const ChatProviderSchema = z.enum(["google", "anthropic"]);
export const ChatModelSchema = z.enum(["flash", "flash-lite", "pro", "sonnet", "haiku", "opus"]);

export const RunRequestSchema = z
  .object({
    brandIds: z.array(z.string().uuid()).min(1).max(1),
    provider: ChatProviderSchema.optional(),
    promptModel: ChatModelSchema.optional(),
    promptGenModel: ChatModelSchema.optional(),
    extractionProvider: ChatProviderSchema.optional(),
    extractionModel: ChatModelSchema.optional(),
    nPrompts: z.number().int().min(5).max(50).optional(),
    weights: VisibilityWeightsSchema.optional(),
  })
  .strict()
  .openapi("VisibilityScoreRunRequest");

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const TopCompetitorSchema = z
  .object({
    name: z.string(),
    url: z.string().nullable(),
    mention_count: z.number(),
    avg_position: z.number().nullable(),
    share_of_voice: z.number(),
    net_sentiment: z.number(),
  })
  .openapi("TopCompetitor");

export const CitationOpportunitySchema = z
  .object({ domain: z.string(), count: z.number() })
  .openapi("CitationOpportunity");

export const PromptDetailSchema = z
  .object({
    id: z.string().uuid(),
    promptIndex: z.number(),
    promptText: z.string(),
    responseText: z.string(),
    responseLengthChars: z.number().nullable(),
    brandFound: z.boolean().nullable(),
    brandCount: z.number().nullable(),
    brandPosition: z.number().nullable(),
    urlFound: z.boolean().nullable(),
    urlCount: z.number().nullable(),
    brandAndUrlCoOccurrence: z.boolean().nullable(),
    maxBrandsInResponse: z.number().nullable(),
    sentiment: z.string().nullable(),
    sentimentScore: z.string().nullable(),
    citationUrls: z.array(z.string()).nullable(),
    latencyMs: z.number().nullable(),
    tokensInput: z.number().nullable(),
    tokensOutput: z.number().nullable(),
  })
  .openapi("PromptDetail");

export const CompetitorDetailSchema = z
  .object({
    id: z.string().uuid(),
    promptIdFk: z.string().uuid(),
    competitorName: z.string(),
    competitorUrl: z.string().nullable(),
    position: z.number().nullable(),
    sentiment: z.string().nullable(),
    sentimentScore: z.string().nullable(),
    citationUrl: z.string().nullable(),
  })
  .openapi("CompetitorDetail");

export const RunRowSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    brandId: z.string().uuid(),
    parentRunId: z.string().uuid().nullable(),
    runId: z.string().uuid().nullable(),
    domain: z.string(),
    brandName: z.string(),
    llmProvider: z.string(),
    llmModel: z.string(),
    promptGenModel: z.string(),
    extractionProvider: z.string(),
    extractionModel: z.string(),
    nPrompts: z.number(),
    weights: VisibilityWeightsSchema,
    visibilityScore: z.string().nullable(),
    brandMentionRate: z.string().nullable(),
    shareOfVoice: z.string().nullable(),
    netSentiment: z.string().nullable(),
    citationRate: z.string().nullable(),
    avgPosition: z.string().nullable(),
    status: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough()
  .openapi("VisibilityScoreRunRow");

export const RunResultSchema = z
  .object({
    run: RunRowSchema,
    prompts: z.array(PromptDetailSchema),
    competitors: z.array(CompetitorDetailSchema),
    top_competitors: z.array(TopCompetitorSchema),
    citation_opportunities: z.array(CitationOpportunitySchema),
  })
  .openapi("VisibilityScoreRunResult");

export const RunResponseSchema = z
  .object({ results: z.array(RunResultSchema) })
  .openapi("VisibilityScoreRunResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/visibility-score-runs",
  tags: ["VisibilityScore"],
  summary: "Run a visibility-score audit for one or more brands",
  description:
    "For each brand ID, runs an N-prompt LLM audit (default 25), extracts structured metrics for the target brand vs. competitors, persists rows, and returns the full bundle.",
  request: {
    headers: z.object(orgScopedHeaders),
    body: { content: { "application/json": { schema: RunRequestSchema } } },
  },
  responses: {
    200: { description: "Run results", content: { "application/json": { schema: RunResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ValidationErrorResponseSchema } } },
    401: { description: "Missing API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Invalid API key", content: { "application/json": { schema: ErrorResponseSchema } } },
    502: { description: "Run-tracking dependency unavailable", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const RunListItemSchema = RunRowSchema.extend({
  visibility_score_delta: z.string().nullable(),
  share_of_voice_delta: z.string().nullable(),
  net_sentiment_delta: z.string().nullable(),
  position_delta: z.string().nullable(),
}).openapi("VisibilityScoreRunListItem");

export const RunListResponseSchema = z
  .object({ runs: z.array(RunListItemSchema), limit: z.number(), offset: z.number() })
  .openapi("VisibilityScoreRunListResponse");

export const RunListQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  domain: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

registry.registerPath({
  method: "get",
  path: "/orgs/visibility-score-runs",
  tags: ["VisibilityScore"],
  summary: "List visibility-score runs with deltas",
  description:
    "Returns runs scoped to the requesting org, optionally filtered by brandId/domain/date range. Each row includes a delta block vs. the immediately previous run for the same brand.",
  request: {
    headers: z.object(orgScopedHeaders),
    query: RunListQuerySchema,
  },
  responses: {
    200: { description: "List of runs", content: { "application/json": { schema: RunListResponseSchema } } },
    400: { description: "Invalid query", content: { "application/json": { schema: ValidationErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/visibility-score-runs/{id}",
  tags: ["VisibilityScore"],
  summary: "Get a single visibility-score run",
  request: {
    headers: z.object(orgScopedHeaders),
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Run bundle", content: { "application/json": { schema: RunResultSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
