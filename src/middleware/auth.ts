import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.AI_VISIBILITY_SCORE_SERVICE_API_KEY;
  if (!expected) {
    return res.status(500).json({
      error: "Server misconfigured: AI_VISIBILITY_SCORE_SERVICE_API_KEY not set",
    });
  }
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(401).json({ error: "Missing x-api-key header" });
  }
  if (apiKey.length !== expected.length) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  if (!crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(expected))) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  return next();
}

export function requireOrgId(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"];
  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({ error: "x-org-id header is required" });
  }
  if (!UUID_RE.test(orgId)) {
    return res.status(400).json({ error: "x-org-id must be a valid UUID" });
  }

  const userId = req.headers["x-user-id"];
  const parentRunId = req.headers["x-run-id"];
  const campaignId = req.headers["x-campaign-id"];
  const audienceId = req.headers["x-audience-id"];
  const featureSlug = req.headers["x-feature-slug"];
  const brandIdHeader = req.headers["x-brand-id"];
  const workflowSlug = req.headers["x-workflow-slug"];

  req.orgId = orgId;
  if (typeof userId === "string" && UUID_RE.test(userId)) req.userId = userId;
  if (typeof parentRunId === "string" && UUID_RE.test(parentRunId)) req.parentRunId = parentRunId;
  if (typeof campaignId === "string" && UUID_RE.test(campaignId)) req.campaignId = campaignId;
  // x-audience-id: priority audience for per-audience cost attribution. Optional (absent
  // off-campaign → omit, never throw). UUID-validated so we never forward a malformed value
  // that would 400 runs-service.
  if (typeof audienceId === "string" && UUID_RE.test(audienceId)) req.audienceId = audienceId;
  if (typeof featureSlug === "string") req.featureSlug = featureSlug;
  if (typeof workflowSlug === "string") req.workflowSlug = workflowSlug;
  if (typeof brandIdHeader === "string") {
    req.brandIdHeader = brandIdHeader;
    const validBrandIds = brandIdHeader
      .split(",")
      .map((s) => s.trim())
      .filter((s) => UUID_RE.test(s));
    if (validBrandIds.length === 0) {
      return res.status(400).json({ error: "x-brand-id must contain at least one valid UUID" });
    }
    req.brandIds = validBrandIds;
  }

  return next();
}
