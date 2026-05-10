const SERVICE_NAME = "ai-visibility-score-service";

export interface RunsRun {
  id: string;
  organizationId?: string;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt?: string;
  createdAt?: string;
}

export interface RunIdentity {
  orgId: string;
  userId?: string;
  parentRunId?: string;
}

export interface ForwardHeaders {
  campaignId?: string;
  featureSlug?: string;
  brandId?: string;
  workflowSlug?: string;
}

function baseUrl(): string {
  const url = process.env.RUNS_SERVICE_URL;
  if (!url) throw new Error("[ai-visibility-score-service] RUNS_SERVICE_URL is required");
  return url;
}

function buildHeaders(identity: RunIdentity, forward?: ForwardHeaders): Record<string, string> {
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[ai-visibility-score-service] RUNS_SERVICE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.parentRunId) headers["x-run-id"] = identity.parentRunId;
  if (forward?.campaignId) headers["x-campaign-id"] = forward.campaignId;
  if (forward?.featureSlug) headers["x-feature-slug"] = forward.featureSlug;
  if (forward?.brandId) headers["x-brand-id"] = forward.brandId;
  if (forward?.workflowSlug) headers["x-workflow-slug"] = forward.workflowSlug;
  return headers;
}

async function runsRequest<T>(
  method: string,
  path: string,
  identity: RunIdentity,
  body?: unknown,
  forward?: ForwardHeaders,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: buildHeaders(identity, forward),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[runs-client] ${method} ${path} returned ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function createRun(
  taskName: string,
  identity: RunIdentity,
  forward?: ForwardHeaders,
): Promise<RunsRun> {
  return runsRequest<RunsRun>(
    "POST",
    "/v1/runs",
    identity,
    { serviceName: SERVICE_NAME, taskName },
    forward,
  );
}

export async function updateRunStatus(
  id: string,
  status: "completed" | "failed",
  identity: RunIdentity,
  forward?: ForwardHeaders,
): Promise<RunsRun> {
  return runsRequest<RunsRun>("PATCH", `/v1/runs/${id}`, identity, { status }, forward);
}

