import { db } from "../db/index.js";
import {
  visibilityAhrefsSnapshots,
  type AhrefEngineMention,
  type AhrefTopCompetitor,
  type VisibilityAhrefsSnapshot,
} from "../db/schema.js";
import {
  fetchAhrefAiVisibility,
  type AhrefAiVisibility,
  type AhrefTrackingHeaders,
} from "./ahref-client.js";

/** Result of the (fail-soft) Ahrefs fetch — never an exception. */
export type AhrefFetchOutcome =
  | { status: "completed"; data: AhrefAiVisibility }
  | { status: "failed"; error: string };

export interface AhrefSnapshotParams {
  orgId: string;
  userId?: string;
  brandId: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
  /** This service's own runId. */
  runId: string;
  /** Aggregate visibility-score run this snapshot belongs to, when one exists. */
  aggregateRunId: string | null;
  domain: string;
  brandName: string | null;
}

/** Serialized snapshot returned to the caller / API response (omits raw payload). */
export interface AhrefSnapshotResult {
  id: string;
  status: "completed" | "failed";
  domain: string;
  snapshotDate: string | null;
  fetchedFromCache: boolean | null;
  mentionsTotal: number | null;
  mentionsByEngine: AhrefEngineMention[] | null;
  topCompetitors: AhrefTopCompetitor[] | null;
  error: string | null;
  createdAt: string;
}

/** Serialize a persisted snapshot row to the API-facing result (omits raw payload). */
export function serializeAhrefSnapshotRow(row: VisibilityAhrefsSnapshot): AhrefSnapshotResult {
  return {
    id: row.id,
    status: row.status,
    domain: row.domain,
    snapshotDate: row.snapshotDate,
    fetchedFromCache: row.fetchedFromCache,
    mentionsTotal: row.mentionsTotal,
    mentionsByEngine: row.mentionsByEngine,
    topCompetitors: row.topCompetitors,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Fetch the brand domain's Ahrefs Brand-Radar stats, catching every error so
 * the visibility run is never coupled to a flaky Brand-Radar scrape. The
 * failure is returned as data (and logged), not swallowed silently.
 */
export async function fetchAhrefSnapshotSafe(
  domain: string,
  tracking: AhrefTrackingHeaders,
): Promise<AhrefFetchOutcome> {
  try {
    const data = await fetchAhrefAiVisibility(domain, tracking);
    return { status: "completed", data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai-visibility-score-service] Ahrefs Brand-Radar fetch failed for domain=${domain}: ${error}`,
    );
    return { status: "failed", error };
  }
}

/**
 * Persist one Ahrefs snapshot row for this run. Never throws — a snapshot
 * persistence failure is logged but does not fail the visibility run.
 */
export async function persistAhrefSnapshot(
  params: AhrefSnapshotParams,
  outcome: AhrefFetchOutcome,
): Promise<AhrefSnapshotResult | null> {
  const data = outcome.status === "completed" ? outcome.data : null;
  try {
    const [row] = await db
      .insert(visibilityAhrefsSnapshots)
      .values({
        orgId: params.orgId,
        userId: params.userId ?? null,
        brandId: params.brandId,
        campaignId: params.campaignId ?? null,
        featureSlug: params.featureSlug ?? null,
        workflowSlug: params.workflowSlug ?? null,
        runId: params.runId,
        aggregateRunId: params.aggregateRunId,
        domain: params.domain,
        brandName: params.brandName,
        status: outcome.status,
        error: outcome.status === "failed" ? outcome.error : null,
        snapshotDate: data?.snapshotDate ?? null,
        fetchedFromCache: data?.fetchedFromCache ?? null,
        mentionsTotal: data?.mentionsTotal ?? null,
        mentionsByEngine: data?.mentionsByEngine ?? null,
        topCompetitors: data?.topCompetitors ?? null,
        raw: data?.raw ?? null,
      })
      .returning();

    return serializeAhrefSnapshotRow(row);
  } catch (err) {
    console.error(
      `[ai-visibility-score-service] failed to persist Ahrefs snapshot for run ${params.runId}:`,
      err,
    );
    return null;
  }
}
