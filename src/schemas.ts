import { z } from "zod";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

const orgScopedHeadersBase = {
  "x-api-key": z.string().openapi({ description: "Service-to-service API key" }),
  "x-org-id": z.string().uuid().openapi({ description: "Internal org UUID" }),
  "x-user-id": z.string().optional().openapi({ description: "Internal user UUID" }),
  "x-run-id": z.string().uuid().optional().openapi({
    description: "Caller's run ID — captured as parentRunId when this service creates its own run",
  }),
  "x-campaign-id": z.string().uuid().optional().openapi({
    description: "Optional caller campaign UUID, forwarded to downstream chat-service / brand-service for tracking.",
  }),
  "x-feature-slug": z.string().optional().openapi({
    description: "Optional caller feature slug, forwarded to downstream services for tracking.",
  }),
  "x-workflow-slug": z.string().optional().openapi({
    description: "Optional caller workflow slug, forwarded to downstream services for tracking.",
  }),
};

const orgScopedHeadersOptionalBrand = {
  ...orgScopedHeadersBase,
  "x-brand-id": z.string().uuid().optional().openapi({
    description:
      "Optional brand UUID filter. Ignored by GET /orgs/visibility-score-runs (use the `brandId` query param to filter). Single UUID — no comma-separated list.",
  }),
};

const orgScopedHeadersRequiredBrand = {
  ...orgScopedHeadersBase,
  "x-brand-id": z.string().uuid().openapi({
    description:
      "Single brand UUID to audit. Required. Co-branding is not supported — exactly one UUID, no comma-separated list.",
  }),
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
  .object({})
  .strict()
  .openapi("VisibilityScoreRunRequest", {
    description:
      "Empty body. The brand to audit is specified via the `x-brand-id` header. All LLM provider/model choices, prompt count, and scoring weights are decided server-side from a canonical config and are not caller-configurable.",
  });

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
    judgeSystemPrompt: z.string().nullable().openapi({
      description: "Exact system prompt string sent to the judge LLM. Persisted for full debug transparency.",
    }),
    judgeUserMessage: z.string().nullable().openapi({
      description:
        "Exact user message string sent to the judge LLM. Equals `promptText` (server does NOT inject brand context into the judge call).",
    }),
    extractorSystemPrompt: z.string().nullable().openapi({
      description: "Exact system prompt string sent to the extractor LLM (the extractor analyzes the judge's output).",
    }),
    extractorUserMessage: z.string().nullable().openapi({
      description:
        "Exact user message string sent to the extractor LLM. Includes `Target brand: <name + domain>` + the judge response.",
    }),
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
    userId: z.string().uuid().nullable(),
    brandId: z.string().uuid(),
    campaignId: z.string().uuid().nullable(),
    featureSlug: z.string().nullable(),
    workflowSlug: z.string().nullable(),
    parentRunId: z.string().uuid().nullable(),
    runId: z.string().uuid().nullable(),
    aggregateRunId: z.string().uuid().nullable().openapi({
      description: "When non-null, this row is a per-provider child of the aggregate run with this id.",
    }),
    judgeKind: z.enum(["aggregate", "per_provider"]).openapi({
      description: "`aggregate` = parent row, mean across providers. `per_provider` = single judge child row.",
    }),
    domain: z.string(),
    brandName: z.string(),
    llmProvider: z.string(),
    llmModel: z.string(),
    promptGenModel: z.string(),
    extractionProvider: z.string(),
    extractionModel: z.string(),
    nPrompts: z.number(),
    weights: VisibilityWeightsSchema,
    visibilityScore: z.string().nullable().openapi({
      description: "Composite score, decimal 0–1 (clamped). Multiply by 100 for percentage display.",
    }),
    brandMentionRate: z.string().nullable().openapi({
      description: "Fraction of prompts that mentioned the brand. Decimal 0–1.",
    }),
    shareOfVoice: z.string().nullable().openapi({
      description: "Brand mentions / (brand + competitor mentions). Decimal 0–1.",
    }),
    netSentiment: z.string().nullable().openapi({
      description: "(positive - negative) / brand_mention_count. Decimal in [-1, 1].",
    }),
    citationRate: z.string().nullable().openapi({
      description: "Citations of the brand domain / N prompts. Decimal 0–1.",
    }),
    avgPosition: z.string().nullable().openapi({
      description: "Mean rank of brand among mentions in responses (1 = first). Lower is better.",
    }),
    promptGenSystemPrompt: z.string().nullable().optional().openapi({
      description:
        "Exact system prompt string sent to the prompt-generator LLM (one call per run, drives the prompts the judges then answer).",
    }),
    promptGenUserMessage: z.string().nullable().optional().openapi({
      description:
        "Exact user message string sent to the prompt-generator LLM. Includes the brand context fields (industry, audience, offerings, geography) — these influence which prompts get generated.",
    }),
    status: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough()
  .openapi("VisibilityScoreRunRow");

export const ByProviderResultSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    run: RunRowSchema,
    prompts: z.array(PromptDetailSchema),
    competitors: z.array(CompetitorDetailSchema),
    top_competitors: z.array(TopCompetitorSchema),
    citation_opportunities: z.array(CitationOpportunitySchema),
  })
  .openapi("VisibilityScoreByProviderResult");

export const RunResultSchema = z
  .object({
    run: RunRowSchema.openapi({
      description: "Aggregate parent row. Metrics are the mean across all judge providers.",
    }),
    by_provider: z.array(ByProviderResultSchema).openapi({
      description: "One entry per judge provider in the run. Order matches the server config.",
    }),
    top_competitors: z.array(TopCompetitorSchema).openapi({
      description: "Top competitors unioned across all judges (by competitor name).",
    }),
    citation_opportunities: z.array(CitationOpportunitySchema).openapi({
      description: "Citation domains unioned across all judges.",
    }),
  })
  .openapi("VisibilityScoreRunResult");

export const RunResponseSchema = z
  .object({ results: z.array(RunResultSchema) })
  .openapi("VisibilityScoreRunResponse");

registry.registerPath({
  method: "post",
  path: "/orgs/visibility-score-runs",
  tags: ["VisibilityScore"],
  summary: "Run a visibility-score audit for a single brand",
  description:
    "Runs an N-prompt LLM audit against the brand identified by `x-brand-id`, extracts structured metrics for the target brand vs. competitors, persists rows, and returns the full bundle.\n\nThe request body MUST be empty (`{}`). All LLM provider/model choices, prompt count, and scoring weights are decided server-side from a canonical config and cannot be overridden by the caller — to change them, ship a new version of the service.",
  request: {
    headers: z.object(orgScopedHeadersRequiredBrand),
    body: { content: { "application/json": { schema: RunRequestSchema, example: {} } } },
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
  campaignId: z.string().uuid().optional(),
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
    "Returns runs scoped to the requesting org, optionally filtered by brandId/campaignId/domain/date range. Each row includes a delta block vs. the immediately previous run for the same brand.",
  request: {
    headers: z.object(orgScopedHeadersOptionalBrand),
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
    headers: z.object(orgScopedHeadersOptionalBrand),
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: { description: "Run bundle", content: { "application/json": { schema: RunResultSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});
