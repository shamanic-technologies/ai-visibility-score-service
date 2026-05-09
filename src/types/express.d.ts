import "express";

declare global {
  namespace Express {
    interface Request {
      orgId?: string;
      userId?: string;
      parentRunId?: string;
      runId?: string;
      campaignId?: string;
      featureSlug?: string;
      brandIdHeader?: string;
      brandIds?: string[];
      workflowSlug?: string;
    }
  }
}
