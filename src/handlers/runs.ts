import type { Request, Response } from "express";
import { sql, eq, and, gte, lte, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  visibilityScoreRuns,
  visibilityScorePrompts,
  visibilityScoreCompetitors,
} from "../db/schema.js";
import { runVisibilityScore } from "../lib/run.js";
import { DEFAULT_WEIGHTS, aggregate } from "../lib/metrics.js";
import { RunRequestSchema, RunListQuerySchema } from "../schemas.js";

export async function postRuns(req: Request, res: Response): Promise<void> {
  if (!req.orgId || !req.runId) {
    res.status(500).json({ error: "Auth + run-tracking middleware did not run" });
    return;
  }

  const parsed = RunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const headerBrandIds = req.brandIds ?? [];
  if (headerBrandIds.length === 0) {
    res.status(400).json({ error: "x-brand-id header is required" });
    return;
  }
  const sortedHeader = [...headerBrandIds].sort().join(",");
  const sortedBody = [...parsed.data.brandIds].sort().join(",");
  if (sortedHeader !== sortedBody) {
    res
      .status(400)
      .json({ error: "x-brand-id header must match brandIds in body (same set, any order)" });
    return;
  }

  const provider = parsed.data.provider ?? "google";
  const promptModel = parsed.data.promptModel ?? "pro";
  const promptGenModel = parsed.data.promptGenModel ?? "flash";
  const extractionProvider = parsed.data.extractionProvider ?? "anthropic";
  const extractionModel = parsed.data.extractionModel ?? "haiku";
  const nPrompts = parsed.data.nPrompts ?? 25;
  const weights = parsed.data.weights ?? DEFAULT_WEIGHTS;

  console.log(
    `[ai-visibility-score-service] starting run org=${req.orgId} brands=[${parsed.data.brandIds.join(",")}] n=${nPrompts}`,
  );

  const settled = await Promise.allSettled(
    parsed.data.brandIds.map((brandId) =>
      runVisibilityScore({
        brandId,
        orgId: req.orgId!,
        userId: req.userId,
        runId: req.runId!,
        parentRunId: req.parentRunId,
        campaignId: req.campaignId,
        featureSlug: req.featureSlug,
        workflowSlug: req.workflowSlug,
        provider,
        promptModel,
        promptGenModel,
        extractionProvider,
        extractionModel,
        nPrompts,
        weights,
      }),
    ),
  );

  const failures = settled
    .map((s, i) => ({ s, brandId: parsed.data.brandIds[i] }))
    .filter((x) => x.s.status === "rejected");

  if (failures.length === parsed.data.brandIds.length) {
    const firstErr = (failures[0].s as PromiseRejectedResult).reason;
    console.error(
      `[ai-visibility-score-service] all brand runs failed`,
      firstErr,
    );
    res.status(500).json({
      error: "All brand runs failed",
      details: { message: firstErr instanceof Error ? firstErr.message : String(firstErr) },
    });
    return;
  }

  if (failures.length > 0) {
    console.warn(
      `[ai-visibility-score-service] partial failure: ${failures.length}/${parsed.data.brandIds.length} brands failed`,
    );
  }

  const results = settled.flatMap((s) => {
    if (s.status !== "fulfilled") return [];
    const r = s.value;
    return [
      {
        run: serializeRun(r.run),
        prompts: r.prompts.map(serializePrompt),
        competitors: r.competitors.map(serializeCompetitor),
        top_competitors: r.metrics.top_competitors,
        citation_opportunities: r.metrics.citation_opportunities,
      },
    ];
  });

  res.json({ results });
}

export async function listRuns(req: Request, res: Response): Promise<void> {
  if (!req.orgId) {
    res.status(500).json({ error: "Auth middleware did not run" });
    return;
  }

  const parsed = RunListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }

  const limit = parsed.data.limit ?? 50;
  const offset = parsed.data.offset ?? 0;
  const filters = [eq(visibilityScoreRuns.orgId, req.orgId)];
  if (parsed.data.brandId) filters.push(eq(visibilityScoreRuns.brandId, parsed.data.brandId));
  if (parsed.data.domain) filters.push(eq(visibilityScoreRuns.domain, parsed.data.domain));
  if (parsed.data.from) filters.push(gte(visibilityScoreRuns.createdAt, new Date(parsed.data.from)));
  if (parsed.data.to) filters.push(lte(visibilityScoreRuns.createdAt, new Date(parsed.data.to)));

  const rows = await db
    .select({
      r: visibilityScoreRuns,
      visibility_score_delta: sql<string | null>`(
        ${visibilityScoreRuns.visibilityScore}::numeric -
        LAG(${visibilityScoreRuns.visibilityScore}::numeric) OVER (
          PARTITION BY ${visibilityScoreRuns.brandId}
          ORDER BY ${visibilityScoreRuns.createdAt}
        )
      )::text`,
      share_of_voice_delta: sql<string | null>`(
        ${visibilityScoreRuns.shareOfVoice}::numeric -
        LAG(${visibilityScoreRuns.shareOfVoice}::numeric) OVER (
          PARTITION BY ${visibilityScoreRuns.brandId}
          ORDER BY ${visibilityScoreRuns.createdAt}
        )
      )::text`,
      net_sentiment_delta: sql<string | null>`(
        ${visibilityScoreRuns.netSentiment}::numeric -
        LAG(${visibilityScoreRuns.netSentiment}::numeric) OVER (
          PARTITION BY ${visibilityScoreRuns.brandId}
          ORDER BY ${visibilityScoreRuns.createdAt}
        )
      )::text`,
      position_delta: sql<string | null>`(
        ${visibilityScoreRuns.avgPosition}::numeric -
        LAG(${visibilityScoreRuns.avgPosition}::numeric) OVER (
          PARTITION BY ${visibilityScoreRuns.brandId}
          ORDER BY ${visibilityScoreRuns.createdAt}
        )
      )::text`,
    })
    .from(visibilityScoreRuns)
    .where(and(...filters))
    .orderBy(desc(visibilityScoreRuns.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    runs: rows.map((row) => ({
      ...serializeRun(row.r),
      visibility_score_delta: row.visibility_score_delta,
      share_of_voice_delta: row.share_of_voice_delta,
      net_sentiment_delta: row.net_sentiment_delta,
      position_delta: row.position_delta,
    })),
    limit,
    offset,
  });
}

export async function getRun(req: Request, res: Response): Promise<void> {
  if (!req.orgId) {
    res.status(500).json({ error: "Auth middleware did not run" });
    return;
  }
  const { id } = req.params;

  const [run] = await db
    .select()
    .from(visibilityScoreRuns)
    .where(and(eq(visibilityScoreRuns.id, id), eq(visibilityScoreRuns.orgId, req.orgId)));

  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const promptRows = await db
    .select()
    .from(visibilityScorePrompts)
    .where(
      and(eq(visibilityScorePrompts.runIdFk, run.id), eq(visibilityScorePrompts.orgId, req.orgId)),
    );

  const competitorRows = await db
    .select()
    .from(visibilityScoreCompetitors)
    .where(
      and(
        eq(visibilityScoreCompetitors.runIdFk, run.id),
        eq(visibilityScoreCompetitors.orgId, req.orgId),
      ),
    );

  const promptIdByIndex = new Map(promptRows.map((p) => [p.promptIndex, p.id]));
  const extracted = promptRows
    .slice()
    .sort((a, b) => a.promptIndex - b.promptIndex)
    .map((p) => ({
      promptIndex: p.promptIndex,
      promptText: p.promptText,
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

  const m = aggregate(extracted, run.domain, run.weights);

  res.json({
    run: serializeRun(run),
    prompts: promptRows.map(serializePrompt),
    competitors: competitorRows.map(serializeCompetitor),
    top_competitors: m.top_competitors,
    citation_opportunities: m.citation_opportunities,
  });
}

function serializeRun(r: typeof visibilityScoreRuns.$inferSelect) {
  return {
    ...r,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function serializePrompt(p: typeof visibilityScorePrompts.$inferSelect) {
  return { ...p, createdAt: p.createdAt.toISOString() };
}

function serializeCompetitor(c: typeof visibilityScoreCompetitors.$inferSelect) {
  return { ...c, createdAt: c.createdAt.toISOString() };
}
