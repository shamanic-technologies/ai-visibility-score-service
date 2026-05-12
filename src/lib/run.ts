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
  aggregateAcrossProviders,
  type AggregateMetrics,
  type ExtractedPrompt,
} from "./metrics.js";
import type { JudgeConfig } from "./config.js";

const PROMPT_CONCURRENCY = 5;

export const JUDGE_SYSTEM_PROMPT = "";

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

  judges: JudgeConfig[];
  promptGenProvider: ChatProvider;
  promptGenModel: ChatModel;
  extractionProvider: ChatProvider;
  extractionModel: ChatModel;
  nPrompts: number;
  weights: VisibilityWeights;
}

export interface JudgeRunResult {
  judge: JudgeConfig;
  run: typeof visibilityScoreRuns.$inferSelect;
  prompts: (typeof visibilityScorePrompts.$inferSelect)[];
  competitors: (typeof visibilityScoreCompetitors.$inferSelect)[];
  metrics: AggregateMetrics;
}

export interface RunResult {
  /** Aggregate (parent) row + merged metrics across all successful judges. */
  run: typeof visibilityScoreRuns.$inferSelect;
  metrics: AggregateMetrics;
  byProvider: JudgeRunResult[];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return undefined;
}

function dec(v: number | null): string | null {
  return v === null ? null : v.toString();
}

export async function runVisibilityScore(opts: RunOptions): Promise<RunResult> {
  if (opts.judges.length === 0) {
    throw new Error("[ai-visibility-score-service] at least one judge is required in config.judges");
  }

  const startedAt = new Date();
  let domain: string | null = null;
  let brandName: string | null = null;

  try {
    return await runVisibilityScoreInner(opts, startedAt, (d, n) => {
      domain = d;
      brandName = n;
    });
  } catch (err) {
    await persistFailedAggregateRun(opts, startedAt, domain, brandName, err);
    throw err;
  }
}

async function persistFailedAggregateRun(
  opts: RunOptions,
  startedAt: Date,
  domain: string | null,
  brandName: string | null,
  err: unknown,
): Promise<void> {
  try {
    await db.insert(visibilityScoreRuns).values({
      orgId: opts.orgId,
      userId: opts.userId ?? null,
      brandId: opts.brandId,
      campaignId: opts.campaignId ?? null,
      featureSlug: opts.featureSlug ?? null,
      workflowSlug: opts.workflowSlug ?? null,
      parentRunId: opts.parentRunId ?? null,
      runId: opts.runId,
      aggregateRunId: null,
      judgeKind: "aggregate",
      domain,
      brandName,
      llmProvider: "aggregate",
      llmModel: opts.judges.map((j) => `${j.provider}/${j.model}`).join(","),
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

interface JudgeExecutionSuccess {
  kind: "ok";
  judge: JudgeConfig;
  extracted: ExtractedPrompt[];
  metrics: AggregateMetrics;
  startedAt: Date;
  completedAt: Date;
}

interface JudgeExecutionFailure {
  kind: "err";
  judge: JudgeConfig;
  error: Error;
  startedAt: Date;
  completedAt: Date;
}

type JudgeExecution = JudgeExecutionSuccess | JudgeExecutionFailure;

async function runJudge(
  judge: JudgeConfig,
  opts: RunOptions,
  prompts: string[],
  brandName: string,
  domain: string,
  baseTracking: ChatTrackingHeaders,
): Promise<JudgeExecution> {
  const startedAt = new Date();
  try {
    const limit = pLimit(PROMPT_CONCURRENCY);
    const extracted: ExtractedPrompt[] = await Promise.all(
      prompts.map((promptText, idx) =>
        limit(async () => {
          const t0 = Date.now();
          const resp = await chatComplete(
            {
              message: promptText,
              systemPrompt: JUDGE_SYSTEM_PROMPT,
              provider: judge.provider,
              model: judge.model,
            },
            baseTracking,
          );
          const latencyMs = Date.now() - t0;

          const extResult = await extractFromResponse({
            responseText: resp.content,
            brandName,
            domain,
            provider: opts.extractionProvider,
            model: opts.extractionModel,
            tracking: baseTracking,
          });
          const ext = extResult.extraction;

          return {
            promptIndex: idx,
            promptText,
            judgeSystemPrompt: JUDGE_SYSTEM_PROMPT,
            judgeUserMessage: promptText,
            extractorSystemPrompt: extResult.systemPrompt,
            extractorUserMessage: extResult.userMessage,
            responseText: resp.content,
            responseLengthChars: resp.content.length,
            brandFound: ext.brandFound,
            brandCount: ext.brandCount,
            brandPosition: ext.brandPosition,
            urlFound: ext.urlFound,
            urlCount: ext.urlCount,
            brandAndUrlCoOccurrence: ext.brandFound && ext.urlFound,
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
    return { kind: "ok", judge, extracted, metrics, startedAt, completedAt: new Date() };
  } catch (err) {
    return {
      kind: "err",
      judge,
      error: err instanceof Error ? err : new Error(String(err)),
      startedAt,
      completedAt: new Date(),
    };
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

  // Generate prompts once; same prompts feed every judge for fair comparison.
  const promptGen = await generatePrompts(ctx, opts.nPrompts, {
    provider: opts.promptGenProvider,
    model: opts.promptGenModel,
    tracking: baseTracking,
  });
  const prompts = promptGen.prompts;

  // Run all judges in parallel.
  const judgeExecutions = await Promise.all(
    opts.judges.map((judge) => runJudge(judge, opts, prompts, brandName, domain, baseTracking)),
  );

  const successes = judgeExecutions.filter((e): e is JudgeExecutionSuccess => e.kind === "ok");
  const failures = judgeExecutions.filter((e): e is JudgeExecutionFailure => e.kind === "err");

  if (successes.length === 0) {
    const messages = failures.map((f) => `${f.judge.provider}/${f.judge.model}: ${f.error.message}`).join("; ");
    throw new Error(`[ai-visibility-score-service] all judges failed — ${messages}`);
  }

  const aggregateMetrics = aggregateAcrossProviders(successes.map((s) => s.metrics));
  const completedAt = new Date();

  const aggregateError = failures.length === 0
    ? null
    : `partial: ${failures.map((f) => `${f.judge.provider}/${f.judge.model}: ${f.error.message}`).join("; ")}`;

  const persisted = await db.transaction(async (tx) => {
    // 1. Insert aggregate parent row first to get its id.
    const [parentRow] = await tx
      .insert(visibilityScoreRuns)
      .values({
        orgId: opts.orgId,
        userId: opts.userId ?? null,
        brandId: opts.brandId,
        campaignId: opts.campaignId ?? null,
        featureSlug: opts.featureSlug ?? null,
        workflowSlug: opts.workflowSlug ?? null,
        parentRunId: opts.parentRunId ?? null,
        runId: opts.runId,
        aggregateRunId: null,
        judgeKind: "aggregate",
        domain,
        brandName,
        llmProvider: "aggregate",
        llmModel: opts.judges.map((j) => `${j.provider}/${j.model}`).join(","),
        promptGenModel: opts.promptGenModel,
        extractionProvider: opts.extractionProvider,
        extractionModel: opts.extractionModel,
        nPrompts: opts.nPrompts,
        weights: opts.weights,
        brandMentionCount: aggregateMetrics.brand_mention_count,
        brandMentionRate: dec(aggregateMetrics.brand_mention_rate),
        urlMentionCount: aggregateMetrics.url_mention_count,
        urlMentionRate: dec(aggregateMetrics.url_mention_rate),
        brandAndUrlCount: aggregateMetrics.brand_and_url_count,
        brandAndUrlRate: dec(aggregateMetrics.brand_and_url_rate),
        avgPosition: dec(aggregateMetrics.avg_position),
        positionScore: dec(aggregateMetrics.position_score),
        shareOfVoice: dec(aggregateMetrics.share_of_voice),
        weightedShareOfVoice: dec(aggregateMetrics.weighted_share_of_voice),
        citationCount: aggregateMetrics.citation_count,
        citationRate: dec(aggregateMetrics.citation_rate),
        citationShareOfVoice: dec(aggregateMetrics.citation_share_of_voice),
        positiveCount: aggregateMetrics.positive_count,
        neutralCount: aggregateMetrics.neutral_count,
        negativeCount: aggregateMetrics.negative_count,
        netSentiment: dec(aggregateMetrics.net_sentiment),
        avgSentimentScore: dec(aggregateMetrics.avg_sentiment_score),
        avgResponseLength: aggregateMetrics.avg_response_length,
        responseLengthWhenBrandFound: aggregateMetrics.response_length_when_brand_found,
        responseLengthWhenBrandNotFound: aggregateMetrics.response_length_when_brand_not_found,
        distinctCompetitorsCount: aggregateMetrics.distinct_competitors_count,
        visibilityScore: dec(aggregateMetrics.visibility_score),
        promptGenSystemPrompt: promptGen.systemPrompt,
        promptGenUserMessage: promptGen.userMessage,
        status: "completed",
        error: aggregateError,
        startedAt,
        completedAt,
      })
      .returning();

    // 2. Insert one child row per judge (success OR failure).
    const judgeRuns: JudgeRunResult[] = [];
    for (const exec of judgeExecutions) {
      const isOk = exec.kind === "ok";
      const m = isOk ? exec.metrics : null;
      const [childRow] = await tx
        .insert(visibilityScoreRuns)
        .values({
          orgId: opts.orgId,
          userId: opts.userId ?? null,
          brandId: opts.brandId,
          campaignId: opts.campaignId ?? null,
          featureSlug: opts.featureSlug ?? null,
          workflowSlug: opts.workflowSlug ?? null,
          parentRunId: opts.parentRunId ?? null,
          runId: opts.runId,
          aggregateRunId: parentRow.id,
          judgeKind: "per_provider",
          domain,
          brandName,
          llmProvider: exec.judge.provider,
          llmModel: exec.judge.model,
          promptGenModel: opts.promptGenModel,
          extractionProvider: opts.extractionProvider,
          extractionModel: opts.extractionModel,
          nPrompts: opts.nPrompts,
          weights: opts.weights,
          brandMentionCount: m?.brand_mention_count ?? null,
          brandMentionRate: m ? dec(m.brand_mention_rate) : null,
          urlMentionCount: m?.url_mention_count ?? null,
          urlMentionRate: m ? dec(m.url_mention_rate) : null,
          brandAndUrlCount: m?.brand_and_url_count ?? null,
          brandAndUrlRate: m ? dec(m.brand_and_url_rate) : null,
          avgPosition: m ? dec(m.avg_position) : null,
          positionScore: m ? dec(m.position_score) : null,
          shareOfVoice: m ? dec(m.share_of_voice) : null,
          weightedShareOfVoice: m ? dec(m.weighted_share_of_voice) : null,
          citationCount: m?.citation_count ?? null,
          citationRate: m ? dec(m.citation_rate) : null,
          citationShareOfVoice: m ? dec(m.citation_share_of_voice) : null,
          positiveCount: m?.positive_count ?? null,
          neutralCount: m?.neutral_count ?? null,
          negativeCount: m?.negative_count ?? null,
          netSentiment: m ? dec(m.net_sentiment) : null,
          avgSentimentScore: m ? dec(m.avg_sentiment_score) : null,
          avgResponseLength: m?.avg_response_length ?? null,
          responseLengthWhenBrandFound: m?.response_length_when_brand_found ?? null,
          responseLengthWhenBrandNotFound: m?.response_length_when_brand_not_found ?? null,
          distinctCompetitorsCount: m?.distinct_competitors_count ?? null,
          visibilityScore: m ? dec(m.visibility_score) : null,
          promptGenSystemPrompt: promptGen.systemPrompt,
          promptGenUserMessage: promptGen.userMessage,
          status: isOk ? "completed" : "failed",
          error: isOk ? null : exec.error.message,
          startedAt: exec.startedAt,
          completedAt: exec.completedAt,
        })
        .returning();

      let promptRows: (typeof visibilityScorePrompts.$inferSelect)[] = [];
      let competitorRows: (typeof visibilityScoreCompetitors.$inferSelect)[] = [];

      if (exec.kind === "ok") {
        promptRows = await tx
          .insert(visibilityScorePrompts)
          .values(
            exec.extracted.map((p) => ({
              runIdFk: childRow.id,
              orgId: opts.orgId,
              promptIndex: p.promptIndex,
              promptText: p.promptText,
              judgeSystemPrompt: p.judgeSystemPrompt,
              judgeUserMessage: p.judgeUserMessage,
              extractorSystemPrompt: p.extractorSystemPrompt,
              extractorUserMessage: p.extractorUserMessage,
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

        const competitorValues = exec.extracted.flatMap((p, i) =>
          p.competitors.map((c) => ({
            runIdFk: childRow.id,
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

        competitorRows =
          competitorValues.length === 0
            ? []
            : await tx.insert(visibilityScoreCompetitors).values(competitorValues).returning();
      }

      judgeRuns.push({
        judge: exec.judge,
        run: childRow,
        prompts: promptRows,
        competitors: competitorRows,
        metrics: exec.kind === "ok" ? exec.metrics : ({} as AggregateMetrics),
      });
    }

    return { parentRow, judgeRuns };
  });

  return {
    run: persisted.parentRow,
    metrics: aggregateMetrics,
    byProvider: persisted.judgeRuns,
  };
}
