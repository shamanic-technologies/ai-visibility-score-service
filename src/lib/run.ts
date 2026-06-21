import pLimit from "p-limit";
import { eq, and, gte, isNull, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  visibilityScoreRuns,
  visibilityScorePrompts,
  visibilityScoreCompetitors,
  visibilityAhrefsSnapshots,
  type VisibilityWeights,
} from "../db/schema.js";
import { extractBrandFields } from "./brand-client.js";
import { chatComplete, type ChatModel, type ChatProvider, type ChatTrackingHeaders } from "./chat-client.js";
import type { AhrefTrackingHeaders } from "./ahref-client.js";
import {
  fetchAhrefSnapshotSafe,
  persistAhrefSnapshot,
  serializeAhrefSnapshotRow,
  type AhrefFetchOutcome,
  type AhrefSnapshotResult,
} from "./ahref-snapshot.js";
import { generatePrompts, SYSTEM_PROMPT as PROMPT_GEN_SYSTEM_PROMPT, type BrandContext } from "./prompt-gen.js";
import { cacheLookup, cacheWrite, computeSystemPromptHash } from "./prompt-cache.js";
import { extractFromResponse } from "./extractor.js";
import {
  aggregate,
  aggregateAcrossProviders,
  type AggregateMetrics,
  type ExtractedPrompt,
} from "./metrics.js";
import type { JudgeConfig } from "./config.js";

const PROMPT_CONCURRENCY = 5;

// Run-level idempotence: re-running the same brand's visibility audit within this
// window serves the most recent COMPLETED run instead of spending LLM tokens again.
// A `failed` run never blocks a retry; a partially-completed run still counts as a
// hit (we prefer saving the spend over a marginally fresher imperfect run).
const RUN_CACHE_TTL_HOURS = 24;

export const JUDGE_SYSTEM_PROMPT = "";

export interface RunOptions {
  brandId: string;
  orgId: string;
  userId?: string;
  /** Outbound x-run-id — this service's own runId. */
  runId: string;
  parentRunId?: string;
  campaignId?: string;
  audienceId?: string;
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
  /**
   * Raw Ahrefs Brand-Radar AI-visibility snapshot for the brand domain at run
   * time. Supplementary to the LLM score; null if the snapshot could not be
   * persisted. A failed Ahrefs fetch still yields a row with status="failed".
   */
  ahrefs: AhrefSnapshotResult | null;
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

  // Run-level 24h idempotence — serve the latest completed audit for this brand and
  // skip brand-resolve + prompt-gen + all grounded judge calls (zero LLM spend).
  // Checked BEFORE inserting a row so a cache hit never creates a duplicate run.
  const cachedRun = await findRecentCompletedRun(opts.orgId, opts.brandId);
  if (cachedRun) {
    console.log(
      `[ai-visibility-score-service] 24h cache hit for brand ${opts.brandId} (run ${cachedRun.id}, created ${cachedRun.createdAt.toISOString()}) — skipping LLM work`,
    );
    return loadRunBundle(cachedRun);
  }

  const startedAt = new Date();
  // Persist the aggregate parent as `running` BEFORE any expensive work. This is the
  // checkpoint that makes a run visible the moment it starts: a campaign is never an
  // invisible money-burning black hole, and a crash / redeploy / timeout mid-run leaves
  // a row the reaper can flip to `failed` instead of vanishing. Children + metrics are
  // filled in incrementally (per judge) and the row is flipped to its terminal state at
  // the end.
  const parent = await insertRunningParent(opts, startedAt);
  try {
    return await runVisibilityScoreInner(opts, parent, startedAt);
  } catch (err) {
    await flipRunFailed(parent.id, err);
    throw err;
  }
}

/** Insert the aggregate parent row in `running` state, before brand-resolve / judges. */
async function insertRunningParent(
  opts: RunOptions,
  startedAt: Date,
): Promise<typeof visibilityScoreRuns.$inferSelect> {
  const [row] = await db
    .insert(visibilityScoreRuns)
    .values({
      orgId: opts.orgId,
      userId: opts.userId ?? null,
      brandId: opts.brandId,
      campaignId: opts.campaignId ?? null,
      audienceId: opts.audienceId ?? null,
      featureSlug: opts.featureSlug ?? null,
      workflowSlug: opts.workflowSlug ?? null,
      parentRunId: opts.parentRunId ?? null,
      runId: opts.runId,
      aggregateRunId: null,
      judgeKind: "aggregate",
      domain: null,
      brandName: null,
      llmProvider: "aggregate",
      llmModel: opts.judges.map((j) => `${j.provider}/${j.model}`).join(","),
      promptGenModel: opts.promptGenModel,
      extractionProvider: opts.extractionProvider,
      extractionModel: opts.extractionModel,
      nPrompts: opts.nPrompts,
      weights: opts.weights,
      status: "running",
      startedAt,
    })
    .returning();
  return row;
}

/**
 * Flip the aggregate parent to `failed`. Best-effort: a failed flip is logged loud and
 * the stuck-run reaper is the backstop — but it must NOT mask the original run error,
 * which the caller rethrows. No new failure row is inserted; the parent already exists
 * from insertRunningParent.
 */
async function flipRunFailed(parentId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    await db
      .update(visibilityScoreRuns)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(eq(visibilityScoreRuns.id, parentId));
  } catch (dbErr) {
    console.error(
      `[ai-visibility-score-service] failed to flip run ${parentId} to 'failed' (reaper will backstop):`,
      dbErr,
    );
  }
}

interface JudgeExecutionSuccess {
  kind: "ok";
  judge: JudgeConfig;
  extracted: ExtractedPrompt[];
  metrics: AggregateMetrics;
  /** Number of prompts that failed but were tolerated (judge kept its successful subset). */
  partialFailures: number;
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
    // Tolerate partial prompt failures: one prompt's 502 (transient LLM error) must NOT
    // discard the other prompts' already-spent grounded answers. Keep every fulfilled
    // prompt; the judge only fails as a whole when EVERY prompt failed.
    const settled = await Promise.allSettled(
      prompts.map((promptText, idx) =>
        limit(async () => {
          const t0 = Date.now();
          const resp = await chatComplete(
            {
              message: promptText,
              systemPrompt: JUDGE_SYSTEM_PROMPT,
              provider: judge.provider,
              model: judge.model,
              // Ground the measured panel: each provider answers via its native
              // web search (Gemini Google Search grounding / Anthropic web_search),
              // so the score reflects what a real user sees — not stale model memory.
              // Prompt-gen and extraction deliberately stay ungrounded.
              webSearch: true,
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

    const extracted: ExtractedPrompt[] = [];
    const failures: string[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        extracted.push(result.value);
      } else {
        failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }

    // Every prompt failed → the judge as a whole failed (propagates to the err branch).
    if (extracted.length === 0) {
      throw new Error(`all ${prompts.length} prompts failed — ${failures[0] ?? "unknown error"}`);
    }
    if (failures.length > 0) {
      console.warn(
        `[ai-visibility-score-service] judge ${judge.provider}/${judge.model}: ${failures.length}/${prompts.length} prompts failed, kept ${extracted.length} (first error: ${failures[0]})`,
      );
    }

    const metrics = aggregate(extracted, domain, opts.weights);
    return {
      kind: "ok",
      judge,
      extracted,
      metrics,
      partialFailures: failures.length,
      startedAt,
      completedAt: new Date(),
    };
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

/**
 * Most recent COMPLETED aggregate run for (orgId, brandId) within the cache window,
 * or null. `failed` runs are ignored so a prior failure never blocks a fresh retry.
 */
async function findRecentCompletedRun(
  orgId: string,
  brandId: string,
): Promise<typeof visibilityScoreRuns.$inferSelect | null> {
  const cutoff = new Date(Date.now() - RUN_CACHE_TTL_HOURS * 60 * 60 * 1000);
  const [row] = await db
    .select()
    .from(visibilityScoreRuns)
    .where(
      and(
        eq(visibilityScoreRuns.orgId, orgId),
        eq(visibilityScoreRuns.brandId, brandId),
        isNull(visibilityScoreRuns.aggregateRunId),
        eq(visibilityScoreRuns.status, "completed"),
        gte(visibilityScoreRuns.createdAt, cutoff),
      ),
    )
    .orderBy(desc(visibilityScoreRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Rebuild the full RunResult bundle (parent + merged metrics + per-provider children)
 * from already-persisted rows. Shared by the 24h cache-hit path and the GET-by-id handler
 * so both reconstruct identical shapes.
 */
export async function loadRunBundle(
  parent: typeof visibilityScoreRuns.$inferSelect,
): Promise<RunResult> {
  const children = await db
    .select()
    .from(visibilityScoreRuns)
    .where(
      and(
        eq(visibilityScoreRuns.aggregateRunId, parent.id),
        eq(visibilityScoreRuns.orgId, parent.orgId),
      ),
    );

  const byProvider: JudgeRunResult[] = [];
  const childMetricsList: AggregateMetrics[] = [];

  for (const child of children) {
    const promptRows = await db
      .select()
      .from(visibilityScorePrompts)
      .where(
        and(
          eq(visibilityScorePrompts.runIdFk, child.id),
          eq(visibilityScorePrompts.orgId, parent.orgId),
        ),
      );

    const competitorRows = await db
      .select()
      .from(visibilityScoreCompetitors)
      .where(
        and(
          eq(visibilityScoreCompetitors.runIdFk, child.id),
          eq(visibilityScoreCompetitors.orgId, parent.orgId),
        ),
      );

    const extracted: ExtractedPrompt[] = promptRows
      .slice()
      .sort((a, b) => a.promptIndex - b.promptIndex)
      .map((p) => ({
        promptIndex: p.promptIndex,
        promptText: p.promptText,
        judgeSystemPrompt: p.judgeSystemPrompt ?? "",
        judgeUserMessage: p.judgeUserMessage ?? "",
        extractorSystemPrompt: p.extractorSystemPrompt ?? "",
        extractorUserMessage: p.extractorUserMessage ?? "",
        responseText: p.responseText,
        responseLengthChars: p.responseLengthChars ?? p.responseText.length,
        brandFound: p.brandFound ?? false,
        brandCount: p.brandCount ?? 0,
        brandPosition: p.brandPosition,
        urlFound: p.urlFound ?? false,
        urlCount: p.urlCount ?? 0,
        brandAndUrlCoOccurrence: p.brandAndUrlCoOccurrence ?? false,
        maxBrandsInResponse: p.maxBrandsInResponse ?? 0,
        sentiment: (p.sentiment ?? "neutral") as "positive" | "neutral" | "negative",
        sentimentScore: p.sentimentScore ? Number(p.sentimentScore) : 0,
        citationUrls: p.citationUrls ?? [],
        competitors: competitorRows
          .filter((c) => c.promptIdFk === p.id)
          .map((c) => ({
            name: c.competitorName,
            url: c.competitorUrl,
            position: c.position ?? 0,
            sentiment: (c.sentiment ?? "neutral") as "positive" | "neutral" | "negative",
            sentimentScore: c.sentimentScore ? Number(c.sentimentScore) : 0,
            citationUrl: c.citationUrl,
          })),
        latencyMs: p.latencyMs ?? 0,
        tokensInput: p.tokensInput ?? 0,
        tokensOutput: p.tokensOutput ?? 0,
      }));

    const childMetrics =
      promptRows.length === 0 ? null : aggregate(extracted, parent.domain ?? "", parent.weights);
    if (childMetrics) childMetricsList.push(childMetrics);

    byProvider.push({
      judge: { provider: child.llmProvider as ChatProvider, model: child.llmModel as ChatModel },
      run: child,
      prompts: promptRows,
      competitors: competitorRows,
      metrics: childMetrics ?? ({} as AggregateMetrics),
    });
  }

  const metrics =
    childMetricsList.length > 0
      ? aggregateAcrossProviders(childMetricsList)
      : ({} as AggregateMetrics);

  // Re-attach the Ahrefs snapshot persisted for this run (most recent for the
  // aggregate), so cache-hit + GET-by-id responses echo the same `ahrefs` block
  // a fresh run returns. Null when none was persisted. Same from/where shape as
  // the queries above; latest picked in JS (one snapshot per run in practice).
  const ahrefRows = await db
    .select()
    .from(visibilityAhrefsSnapshots)
    .where(
      and(
        eq(visibilityAhrefsSnapshots.aggregateRunId, parent.id),
        eq(visibilityAhrefsSnapshots.orgId, parent.orgId),
      ),
    );
  const ahrefRow = ahrefRows
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  const ahrefs = ahrefRow ? serializeAhrefSnapshotRow(ahrefRow) : null;

  return { run: parent, metrics, byProvider, ahrefs };
}

async function runVisibilityScoreInner(
  opts: RunOptions,
  parent: typeof visibilityScoreRuns.$inferSelect,
  startedAt: Date,
): Promise<RunResult> {
  const baseTracking: ChatTrackingHeaders = {
    orgId: opts.orgId,
    userId: opts.userId,
    runId: opts.runId,
    campaignId: opts.campaignId,
    audienceId: opts.audienceId,
    featureSlug: opts.featureSlug,
    brandId: opts.brandId,
    workflowSlug: opts.workflowSlug,
  };

  const brandResp = await extractBrandFields(
    [
      {
        key: "category",
        description:
          "Narrowest service category the brand belongs to — not the industry parent. Two-to-five words. The category must be specific enough that two firms inside it are direct substitutes.",
      },
      {
        key: "specific_offerings",
        description:
          "Concrete named products, programs, packages, routes, tiers or service lines listed on the brand's site. Use the brand's own names. Comma-separated list.",
      },
      {
        key: "target_audience",
        description:
          "The specific buyer segment (nationality, wealth bracket, life situation, company stage, role) — not a generic demographic.",
      },
      {
        key: "primary_geography",
        description:
          "Where the service is delivered AND the markets it serves. State both when they differ.",
      },
      {
        key: "positioning",
        description:
          "The single sharpest differentiation claim from the brand's own site (license, independence, vintage, certification, awards, regulator, methodology).",
      },
    ],
    {
      orgId: opts.orgId,
      userId: opts.userId,
      runId: opts.runId,
      brandId: opts.brandId,
      campaignId: opts.campaignId,
      audienceId: opts.audienceId,
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
  // Stamp the resolved brand onto the running row so an in-flight (or later-failed) run
  // shows which brand it is instead of a null.
  await db
    .update(visibilityScoreRuns)
    .set({ domain, brandName })
    .where(eq(visibilityScoreRuns.id, parent.id));

  // Kick off the Ahrefs Brand-Radar fetch in parallel with the judges so it
  // adds no wall-clock latency beyond the slower of the two. Fail-soft: the
  // outcome is captured (completed/failed) and persisted after the run is
  // stored — it never blocks or fails the visibility score.
  const ahrefTracking: AhrefTrackingHeaders = {
    orgId: opts.orgId,
    userId: opts.userId,
    runId: opts.runId,
    brandId: opts.brandId,
    campaignId: opts.campaignId,
    audienceId: opts.audienceId,
    featureSlug: opts.featureSlug,
    workflowSlug: opts.workflowSlug,
  };
  const ahrefOutcomePromise: Promise<AhrefFetchOutcome> = fetchAhrefSnapshotSafe(
    domain,
    ahrefTracking,
  );

  const ctx: BrandContext = {
    category: asString(brandResp.fields["category"]?.value),
    specific_offerings: asString(brandResp.fields["specific_offerings"]?.value),
    target_audience: asString(brandResp.fields["target_audience"]?.value),
    primary_geography: asString(brandResp.fields["primary_geography"]?.value),
    positioning: asString(brandResp.fields["positioning"]?.value),
  };

  // Generate prompts once; same prompts feed every judge for fair comparison.
  // Cache lookup keyed by (brandId, n, provider, model, system_prompt_hash) — 30-day TTL.
  // Reuse keeps week-over-week reports comparable and skips one LLM call per run.
  const systemPromptHash = computeSystemPromptHash(PROMPT_GEN_SYSTEM_PROMPT);
  const cacheKey = {
    brandId: opts.brandId,
    nPrompts: opts.nPrompts,
    promptGenProvider: opts.promptGenProvider,
    promptGenModel: opts.promptGenModel,
    systemPromptHash,
  };
  const cached = await cacheLookup(cacheKey);
  let promptGen: { prompts: string[]; systemPrompt: string; userMessage: string };
  if (cached) {
    console.log(
      `[ai-visibility-score-service] prompt cache hit for brand ${opts.brandId} (${opts.promptGenProvider}/${opts.promptGenModel}, n=${opts.nPrompts})`,
    );
    promptGen = cached;
  } else {
    promptGen = await generatePrompts(ctx, opts.nPrompts, {
      provider: opts.promptGenProvider,
      model: opts.promptGenModel,
      tracking: baseTracking,
    });
    await cacheWrite({
      ...cacheKey,
      systemPrompt: promptGen.systemPrompt,
      userMessage: promptGen.userMessage,
      prompts: promptGen.prompts,
    });
  }
  const prompts = promptGen.prompts;

  // Run all judges in parallel; each judge persists its OWN child run + prompts +
  // competitors the moment it finishes (independent transaction). This is the
  // incremental checkpoint: a judge that completed survives even if the process dies
  // before the others finish, so already-spent grounded answers are never lost.
  const judgeResults = await Promise.all(
    opts.judges.map(async (judge) => {
      const exec = await runJudge(judge, opts, prompts, brandName, domain, baseTracking);
      const persisted = await persistJudgeRun(exec, opts, parent.id, domain, brandName, promptGen);
      return { exec, persisted };
    }),
  );

  const successes = judgeResults
    .map((r) => r.exec)
    .filter((e): e is JudgeExecutionSuccess => e.kind === "ok");
  const failures = judgeResults
    .map((r) => r.exec)
    .filter((e): e is JudgeExecutionFailure => e.kind === "err");

  if (successes.length === 0) {
    const messages = failures
      .map((f) => `${f.judge.provider}/${f.judge.model}: ${f.error.message}`)
      .join("; ");
    // Children already persisted as `failed`; the outer catch flips the parent to failed.
    throw new Error(`[ai-visibility-score-service] all judges failed — ${messages}`);
  }

  const aggregateMetrics = aggregateAcrossProviders(successes.map((s) => s.metrics));
  const completedAt = new Date();

  const aggregateError =
    failures.length === 0
      ? null
      : `partial: ${failures.map((f) => `${f.judge.provider}/${f.judge.model}: ${f.error.message}`).join("; ")}`;

  // Flip the parent to its terminal state with the merged metrics across judges.
  const parentRow = await flipRunCompleted({
    parentId: parent.id,
    domain,
    brandName,
    metrics: aggregateMetrics,
    error: aggregateError,
    promptGen,
    completedAt,
  });

  // Persist the Ahrefs snapshot linked to the aggregate run. Awaited (the fetch
  // already ran in parallel with the judges) but never throws.
  const ahrefOutcome = await ahrefOutcomePromise;
  const ahrefs = await persistAhrefSnapshot(
    {
      orgId: opts.orgId,
      userId: opts.userId,
      brandId: opts.brandId,
      campaignId: opts.campaignId,
      audienceId: opts.audienceId,
      featureSlug: opts.featureSlug,
      workflowSlug: opts.workflowSlug,
      runId: opts.runId,
      aggregateRunId: parentRow.id,
      domain,
      brandName,
    },
    ahrefOutcome,
  );

  return {
    run: parentRow,
    metrics: aggregateMetrics,
    byProvider: judgeResults.map((r) => r.persisted),
    ahrefs,
  };
}

/**
 * Persist one judge's child run + its prompts + competitors in a single transaction,
 * independent of the other judges. Called as each judge completes so a finished judge's
 * (paid-for) results survive even if the process dies before the others finish. A failed
 * judge still gets a `failed` child row (no prompts) for diagnostics.
 */
async function persistJudgeRun(
  exec: JudgeExecution,
  opts: RunOptions,
  parentDbId: string,
  domain: string,
  brandName: string,
  promptGen: { systemPrompt: string; userMessage: string },
): Promise<JudgeRunResult> {
  const isOk = exec.kind === "ok";
  const m = isOk ? exec.metrics : null;
  return await db.transaction(async (tx) => {
    const [childRow] = await tx
      .insert(visibilityScoreRuns)
      .values({
        orgId: opts.orgId,
        userId: opts.userId ?? null,
        brandId: opts.brandId,
        campaignId: opts.campaignId ?? null,
        audienceId: opts.audienceId ?? null,
        featureSlug: opts.featureSlug ?? null,
        workflowSlug: opts.workflowSlug ?? null,
        parentRunId: opts.parentRunId ?? null,
        runId: opts.runId,
        aggregateRunId: parentDbId,
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
        error: isOk
          ? exec.partialFailures > 0
            ? `partial: ${exec.partialFailures}/${opts.nPrompts} prompts failed`
            : null
          : exec.error.message,
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

    return {
      judge: exec.judge,
      run: childRow,
      prompts: promptRows,
      competitors: competitorRows,
      metrics: exec.kind === "ok" ? exec.metrics : ({} as AggregateMetrics),
    };
  });
}

/**
 * Flip the aggregate parent (already `running`) to `completed`, writing the merged
 * metrics across all successful judges. Returns the updated parent row. A partial run
 * (some judges failed) is still `completed` with `error` set to a "partial: ..." note —
 * matching the prior convention.
 */
async function flipRunCompleted(args: {
  parentId: string;
  domain: string;
  brandName: string;
  metrics: AggregateMetrics;
  error: string | null;
  promptGen: { systemPrompt: string; userMessage: string };
  completedAt: Date;
}): Promise<typeof visibilityScoreRuns.$inferSelect> {
  const { parentId, domain, brandName, metrics, error, promptGen, completedAt } = args;
  const [row] = await db
    .update(visibilityScoreRuns)
    .set({
      domain,
      brandName,
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
      promptGenSystemPrompt: promptGen.systemPrompt,
      promptGenUserMessage: promptGen.userMessage,
      status: "completed",
      error,
      completedAt,
    })
    .where(eq(visibilityScoreRuns.id, parentId))
    .returning();
  return row;
}
