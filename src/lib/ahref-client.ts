import type { AhrefEngineMention, AhrefTopCompetitor } from "../db/schema.js";

/**
 * Raw Ahrefs Brand-Radar AI-visibility stats for a domain, as returned by
 * ahref-service `POST /orgs/domains/ai-visibility`. Counts only — no score.
 */
export interface AhrefAiVisibility {
  domain: string;
  /** Date the Ahrefs data reflects (e.g. "2026-06-01"), or null if unknown. */
  snapshotDate: string | null;
  fetchedFromCache: boolean;
  /** Global brand mentions across all AI engines. */
  mentionsTotal: number;
  /** Per-AI-engine breakdown. */
  mentionsByEngine: AhrefEngineMention[];
  /** Top competitor brands by global citation count. */
  topCompetitors: AhrefTopCompetitor[];
  /** Full upstream payload — preserve everything. */
  raw: Record<string, unknown>;
}

export interface AhrefTrackingHeaders {
  orgId: string;
  userId?: string;
  /** Outbound x-run-id — this service's own runId (so ahref-service attributes its scrape cost to our run). */
  runId: string;
  /** Single brand UUID — passed as x-brand-id. */
  brandId: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

/**
 * Brand-Radar scrapes can be slow (Apify). The fetch is bounded so a cold-cache
 * domain can never hang a visibility run; on timeout the caller records a failed
 * snapshot and the next run (data now warm) succeeds.
 */
export const DEFAULT_AHREF_TIMEOUT_MS = 60_000;

function baseUrl(): string {
  const url = process.env.AHREF_SERVICE_URL;
  if (!url) throw new Error("[ai-visibility-score-service] AHREF_SERVICE_URL is required");
  return url;
}

function buildHeaders(tracking: AhrefTrackingHeaders): Record<string, string> {
  const apiKey = process.env.AHREF_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[ai-visibility-score-service] AHREF_SERVICE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": tracking.orgId,
    "x-run-id": tracking.runId,
    "x-brand-id": tracking.brandId,
  };
  if (tracking.userId) headers["x-user-id"] = tracking.userId;
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  return headers;
}

/**
 * Fetch the brand domain's Ahrefs Brand-Radar AI-visibility stats from
 * ahref-service. Strict: throws on missing config, timeout, or any non-2xx.
 * The caller (ahref-snapshot) is responsible for fail-soft handling.
 */
export async function fetchAhrefAiVisibility(
  domain: string,
  tracking: AhrefTrackingHeaders,
  opts: { timeoutMs?: number } = {},
): Promise<AhrefAiVisibility> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AHREF_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/orgs/domains/ai-visibility`, {
      method: "POST",
      headers: buildHeaders(tracking),
      body: JSON.stringify({ domain }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `[ahref-client] POST /orgs/domains/ai-visibility timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[ahref-client] POST /orgs/domains/ai-visibility returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as AhrefAiVisibility;
}
