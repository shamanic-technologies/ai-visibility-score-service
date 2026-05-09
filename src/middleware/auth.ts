import type { Request, Response, NextFunction } from "express";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return res.status(500).json({
      error: "Server misconfigured: INTERNAL_API_KEY not set",
    });
  }
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") {
    return res.status(401).json({ error: "Missing x-api-key header" });
  }
  if (apiKey !== expected) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  return next();
}

export function requireOrgId(req: Request, res: Response, next: NextFunction) {
  const orgId = req.headers["x-org-id"];
  if (!orgId || typeof orgId !== "string") {
    return res.status(400).json({ error: "x-org-id header is required" });
  }

  const userId = req.headers["x-user-id"];
  const parentRunId = req.headers["x-run-id"];
  const campaignId = req.headers["x-campaign-id"];
  const featureSlug = req.headers["x-feature-slug"];
  const brandIdHeader = req.headers["x-brand-id"];
  const workflowSlug = req.headers["x-workflow-slug"];

  req.orgId = orgId;
  if (typeof userId === "string") req.userId = userId;
  if (typeof parentRunId === "string") req.parentRunId = parentRunId;
  if (typeof campaignId === "string") req.campaignId = campaignId;
  if (typeof featureSlug === "string") req.featureSlug = featureSlug;
  if (typeof workflowSlug === "string") req.workflowSlug = workflowSlug;
  if (typeof brandIdHeader === "string") {
    req.brandIdHeader = brandIdHeader;
    req.brandIds = brandIdHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return next();
}
