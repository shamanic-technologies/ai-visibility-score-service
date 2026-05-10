export interface BrandFieldRequest {
  key: string;
  description: string;
}

export interface BrandFieldResult {
  brandId: string;
  /** May be a flat record (single-brand) or a per-brand object — we always pass single brand. */
  fields: Record<string, unknown>;
  brand?: {
    id?: string;
    name?: string;
    domain?: string;
    url?: string;
  };
}

export interface BrandTrackingHeaders {
  orgId: string;
  userId?: string;
  /** Outbound x-run-id — this service's own runId. */
  runId: string;
  /** Single brand UUID — passed as `x-brand-id`. */
  brandId: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

function baseUrl(): string {
  const url = process.env.BRAND_SERVICE_URL;
  if (!url) throw new Error("[ai-visibility-score-service] BRAND_SERVICE_URL is required");
  return url;
}

function buildHeaders(tracking: BrandTrackingHeaders): Record<string, string> {
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[ai-visibility-score-service] BRAND_SERVICE_API_KEY is required");

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

export async function extractBrandFields(
  fields: BrandFieldRequest[],
  tracking: BrandTrackingHeaders,
): Promise<BrandFieldResult> {
  const res = await fetch(`${baseUrl()}/orgs/brands/extract-fields`, {
    method: "POST",
    headers: buildHeaders(tracking),
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[brand-client] POST /orgs/brands/extract-fields returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as BrandFieldResult;
}

