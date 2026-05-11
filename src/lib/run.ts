import pLimit from "p-limit";
import { db } from "../db/index.js";
import {
  visibilityScoreRuns,
  visibilityScorePrompts,
  visibilityScoreCompetitors,
  type VisibilityWeights,
} from "../db/schema.js";
import { extractBrandFields } from "./brand-client.js";
import { chatComplete, type ChatModel, type ChatProvider, type ChatTrackingHeaders } from "./chat-client.js";
import { generatePrompts, type BrandContext } from "./prompt-gen.js";
import { extractFromResponse } from "./extractor.js";
import {
  aggregate,
  DEFAULT_WEIGHTS,
  type AggregateMetrics,
  type ExtractedPrompt,
} from "./metrics.js";

const PROMPT_CONCURRENCY = 5;

export interface RunOptions {
  brandId: string;
  orgId: string;
  userId?: string;
  /** Outbound x-run-id — this service's own runId. */
  runId: string;
  parentRunId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;

  provider: ChatProvider;
  promptModel: ChatModel;
  promptGenProvider: ChatProvider;
  promptGenModel: ChatModel;
  extractionProvider: ChatProvider;
  extractionModel: ChatModel;
  nPrompts: number;
  weights: VisibilityWeights;
}

export interface RunResult {
  run: typeof visibilityScoreRuns.$inferSelect;
  prompts: (typeof visibilityScorePrompts.$inferSelect)[];
  competitors: (typeof visibilityScoreCompetitors.$inferSelect)[];
  metrics: AggregateMetrics;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return undefined;
}

function dec(v: number | null): string | null {
  return v === null ? null : v.toString();
}

export async function runVisibilityScore(opts: RunOptions): Promise<RunResult> {
  const startedAt = new Date();
  let domain: string | null = null;
  let brandName: string | null = null;

  try {
    return await runVisibilityScoreInner(opts, startedAt, (d, n) => {
      domain = d;
      brandName = n;
    });
  } catch (err) {
    await persistFailedRun(opts, startedAt, domain, brandName, err);
    throw err;
  }
}

async function persistFailedRun(
  opts: RunOptions,
  startedAt: Date,
  domain: string | null,
  brandName: string | null,
  err: unknown,
): Promise<void> {
  try {
    await db.insert(visibilityScoreRuns).values({
      orgId: opts.orgId,
      brandId: opts.brandId,
      parentRunId: opts.parentRunId ?? null,
      runId: opts.runId,
      domain,
      brandName,
      llmProvider: opts.provider,
      llmModel: opts.promptModel,
      promptGenModel: opts.promptGenModel,
      extractionProvider: opts.extractionProvider,
      extractionModel: opts.extractionModel,
      nPrompts: opts.nPrompts,
      weights: opts.weights,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    });
  } catch (dbErr) {
    console.error(
      `[ai-visibility-score-service] failed to persist failure row for run ${opts.runId}:`,
      dbErr,
    );
  }
}

async function runVisibilityScoreInner(
  opts: RunOptions,
  startedAt: Date,
  onBrandResolved: (domain: string, brandName: string) => void,
): Promise<RunResult> {
  const baseTracking: ChatTrackingHeaders = {
    orgId: opts.orgId,
    userId: opts.userId,
    runId: opts.runId,
    campaignId: opts.campaignId,
    featureSlug: opts.featureSlug,
    brandId: opts.brandId,
    workflowSlug: opts.workflowSlug,
  };

  const brandResp = await extractBrandFields(
    [
      { key: "industry", description: "primary industry vertical" },
      { key: "target_audience", description: "who the brand serves" },
      { key: "offerings", description: "products/services" },
      { key: "geography", description: "primary markets" },
    ],
    {
      orgId: opts.orgId,
      userId: opts.userId,
      runId: opts.runId,
      brandId: opts.brandId,
      campaignId: opts.campaignId,
      featureSlug: opts.featureSlug,
      workflowSlug: opts.workflowSlug,
    },
  );

  if (brandResp.brands.length !== 1) {
    throw new Error(
      `[ai-visibility-score-service] brand-service returned ${brandResp.brands.length} brands, expected 1 (brandId=${opts.brandId})`,
    );
  }
  const brand = brandResp.brands[0];
  if (brand.brandId !== opts.brandId) {
    throw new Error(
      `[ai-visibility-score-service] brand-service returned brandId=${brand.brandId}, expected ${opts.brandId}`,
    );
  }
  if (!brand.domain) {
    throw new Error(
      `[ai-visibility-score-service] brand ${opts.brandId} has no domain — cannot run visibility audit`,
    );
  }
  const brandName = asString(brand.name) ?? "(unknown brand)";
  const domain = brand.domain;
  onBrandResolved(domain, brandName);

  const ctx: BrandContext = {
    industry: asString(brandResp.fields["industry"]?.value),
    target_audience: asString(brandResp.fields["target_audience"]?.value),
    offerings: asString(brandResp.fields["offerings"]?.value),
    geography: asString(brandResp.fields["geography"]?.value),
  };

  const prompts = await generatePrompts(ctx, opts.nPrompts, {
    provider: opts.promptGenProvider,
    model: opts.promptGenModel,
    tracking: baseTracking,
  });

  const limit = pLimit(PROMPT_CONCURRENCY);
  const extracted: ExtractedPrompt[] = await Promise.all(
    prompts.map((promptText, idx) =>
      limit(async () => {
        const t0 = Date.now();
        const resp = await chatComplete(
          {
            message: promptText,
            systemPrompt: "You are a helpful assistant. Answer the user's question.",
            provider: opts.provider,
            model: opts.promptModel,
          },
          baseTracking,
        );
        const latencyMs = Date.now() - t0;

        const ext = await extractFromResponse({
          responseText: resp.content,
          brandName,
          domain,
          provider: opts.extractionProvider,
          model: opts.extractionModel,
          tracking: baseTracking,
        });

        const brandAndUrlCoOccurrence = ext.brandFound && ext.urlFound;

        return {
          promptIndex: idx,
          promptText,
          responseText: resp.content,
          responseLengthChars: resp.content.length,
          brandFound: ext.brandFound,
          brandCount: ext.brandCount,
          brandPosition: ext.brandPosition,
          urlFound: ext.urlFound,
          urlCount: ext.urlCount,
          brandAndUrlCoOccurrence,
          maxBrandsInResponse: ext.maxBrandsInResponse,
          sentiment: ext.sentiment,
          sentimentScore: ext.sentimentScore,
          citationUrls: ext.citationUrls,
          competitors: ext.competitors,
          latencyMs,
          tokensInput: resp.tokensInput,
          tokensOutput: resp.tokensOutput,
        };
      }),
    ),
  );

  const metrics = aggregate(extracted, domain, opts.weights);
  const completedAt = new Date();

  const persisted = await db.transaction(async (tx) => {
    const [runRow] = await tx
      .insert(visibilityScoreRuns)
      .values({
        orgId: opts.orgId,
        brandId: opts.brandId,
        parentRunId: opts.parentRunId ?? null,
        runId: opts.runId,
        domain,
        brandName,
        llmProvider: opts.provider,
        llmModel: opts.promptModel,
        promptGenModel: opts.promptGenModel,
        extractionProvider: opts.extractionProvider,
        extractionModel: opts.extractionModel,
        nPrompts: opts.nPrompts,
        weights: opts.weights,
        brandMentionCount: metrics.brand_mention_count,
        brandMentionRate: dec(metrics.brand_mention_rate),
        urlMentionCount: metrics.url_mention_count,
        urlMentionRate: dec(metrics.url_mention_rate),
        brandAndUrlCount: metrics.brand_and_url_count,
        brandAndUrlRate: dec(metrics.brand_and_url_rate),
        avgPosition: dec(metrics.avg_position),
        positionScore: dec(metrics.position_score),
        shareOfVoice: dec(metrics.share_of_voice),
        weightedShareOfVoice: dec(metrics.weighted_share_of_voice),
        citationCount: metrics.citation_count,
        citationRate: dec(metrics.citation_rate),
        citationShareOfVoice: dec(metrics.citation_share_of_voice),
        positiveCount: metrics.positive_count,
        neutralCount: metrics.neutral_count,
        negativeCount: metrics.negative_count,
        netSentiment: dec(metrics.net_sentiment),
        avgSentimentScore: dec(metrics.avg_sentiment_score),
        avgResponseLength: metrics.avg_response_length,
        responseLengthWhenBrandFound: metrics.response_length_when_brand_found,
        responseLengthWhenBrandNotFound: metrics.response_length_when_brand_not_found,
        distinctCompetitorsCount: metrics.distinct_competitors_count,
        visibilityScore: dec(metrics.visibility_score),
        status: "completed",
        startedAt,
        completedAt,
      })
      .returning();

    const promptRows = await tx
      .insert(visibilityScorePrompts)
      .values(
        extracted.map((p) => ({
          runIdFk: runRow.id,
          orgId: opts.orgId,
          promptIndex: p.promptIndex,
          promptText: p.promptText,
          responseText: p.responseText,
          responseLengthChars: p.responseLengthChars,
          brandFound: p.brandFound,
          brandCount: p.brandCount,
          brandPosition: p.brandPosition,
          urlFound: p.urlFound,
          urlCount: p.urlCount,
          brandAndUrlCoOccurrence: p.brandAndUrlCoOccurrence,
          maxBrandsInResponse: p.maxBrandsInResponse,
          sentiment: p.sentiment,
          sentimentScore: dec(p.sentimentScore),
          citationUrls: p.citationUrls,
          latencyMs: p.latencyMs,
          tokensInput: p.tokensInput,
          tokensOutput: p.tokensOutput,
        })),
      )
      .returning();

    const competitorValues = extracted.flatMap((p, i) =>
      p.competitors.map((c) => ({
        runIdFk: runRow.id,
        promptIdFk: promptRows[i].id,
        orgId: opts.orgId,
        competitorName: c.name,
        competitorUrl: c.url,
        position: c.position,
        sentiment: c.sentiment,
        sentimentScore: dec(c.sentimentScore),
        citationUrl: c.citationUrl,
      })),
    );

    const competitorRows =
      competitorValues.length === 0
        ? []
        : await tx.insert(visibilityScoreCompetitors).values(competitorValues).returning();

    return { runRow, promptRows, competitorRows };
  });

  return {
    run: persisted.runRow,
    prompts: persisted.promptRows,
    competitors: persisted.competitorRows,
    metrics,
  };
}
