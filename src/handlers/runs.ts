import type { Request, Response } from "express";
import { sql, eq, and, gte, lte, desc, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  visibilityScoreRuns,
  visibilityScorePrompts,
  visibilityScoreCompetitors,
} from "../db/schema.js";
import { runVisibilityScore, loadRunBundle } from "../lib/run.js";
import { VISIBILITY_RUN_CONFIG } from "../lib/config.js";
import { RunRequestSchema, RunListQuerySchema } from "../schemas.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (headerBrandIds.length !== 1) {
    res
      .status(400)
      .json({ error: "x-brand-id header must contain exactly one brand id (co-branding not supported)" });
    return;
  }
  const brandId = headerBrandIds[0];
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "x-brand-id header must be a valid UUID" });
    return;
  }

  console.log(
    `[ai-visibility-score-service] starting run org=${req.orgId} brand=${brandId} n=${VISIBILITY_RUN_CONFIG.nPrompts} judges=${VISIBILITY_RUN_CONFIG.judges.map((j) => `${j.provider}/${j.model}`).join(",")}`,
  );

  let r;
  try {
    r = await runVisibilityScore({
      brandId,
      orgId: req.orgId,
      userId: req.userId,
      runId: req.runId,
      parentRunId: req.parentRunId,
      campaignId: req.campaignId,
      featureSlug: req.featureSlug,
      workflowSlug: req.workflowSlug,
      judges: VISIBILITY_RUN_CONFIG.judges,
      promptGenProvider: VISIBILITY_RUN_CONFIG.promptGenProvider,
      promptGenModel: VISIBILITY_RUN_CONFIG.promptGenModel,
      extractionProvider: VISIBILITY_RUN_CONFIG.extractionProvider,
      extractionModel: VISIBILITY_RUN_CONFIG.extractionModel,
      nPrompts: VISIBILITY_RUN_CONFIG.nPrompts,
      weights: VISIBILITY_RUN_CONFIG.weights,
    });
  } catch (err) {
    console.error(`[ai-visibility-score-service] brand run failed for ${brandId}:`, err);
    res.status(500).json({
      error: "Brand run failed",
      details: { message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  res.json({
    results: [
      {
        run: serializeRun(r.run),
        by_provider: r.byProvider.map((j) => ({
          provider: j.judge.provider,
          model: j.judge.model,
          run: serializeRun(j.run),
          prompts: j.prompts.map(serializePrompt),
          competitors: j.competitors.map(serializeCompetitor),
          top_competitors: j.metrics.top_competitors ?? [],
          citation_opportunities: j.metrics.citation_opportunities ?? [],
        })),
        top_competitors: r.metrics.top_competitors,
        citation_opportunities: r.metrics.citation_opportunities,
      },
    ],
  });
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
  // List endpoint returns aggregate (parent) rows only — children are accessed via GET /:id.
  const filters = [
    eq(visibilityScoreRuns.orgId, req.orgId),
    isNull(visibilityScoreRuns.aggregateRunId),
  ];
  if (parsed.data.brandId) filters.push(eq(visibilityScoreRuns.brandId, parsed.data.brandId));
  if (parsed.data.campaignId) filters.push(eq(visibilityScoreRuns.campaignId, parsed.data.campaignId));
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
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid run id format" });
    return;
  }

  // Look up the requested row. May be an aggregate parent or a per-provider child.
  const [requested] = await db
    .select()
    .from(visibilityScoreRuns)
    .where(and(eq(visibilityScoreRuns.id, id), eq(visibilityScoreRuns.orgId, req.orgId)));

  if (!requested) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  // Normalize to the aggregate parent — clients should always receive parent + by_provider.
  const parentId = requested.aggregateRunId ?? requested.id;
  const [parent] =
    requested.aggregateRunId === null
      ? [requested]
      : await db
          .select()
          .from(visibilityScoreRuns)
          .where(and(eq(visibilityScoreRuns.id, parentId), eq(visibilityScoreRuns.orgId, req.orgId)));

  if (!parent) {
    res.status(404).json({ error: "Aggregate parent row not found" });
    return;
  }

  // Rebuild the bundle from persisted rows (shared with the 24h cache-hit path).
  const bundle = await loadRunBundle(parent);

  res.json({
    run: serializeRun(bundle.run),
    by_provider: bundle.byProvider.map((b) => ({
      provider: b.judge.provider,
      model: b.judge.model,
      run: serializeRun(b.run),
      prompts: b.prompts.map(serializePrompt),
      competitors: b.competitors.map(serializeCompetitor),
      top_competitors: b.metrics.top_competitors ?? [],
      citation_opportunities: b.metrics.citation_opportunities ?? [],
    })),
    top_competitors: bundle.metrics.top_competitors ?? [],
    citation_opportunities: bundle.metrics.citation_opportunities ?? [],
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
