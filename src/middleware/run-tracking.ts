import type { Request, Response, NextFunction } from "express";
import { createRun, updateRunStatus, type ForwardHeaders } from "../lib/runs-client.js";

/**
 * Creates this service's own run in runs-service, attaches `req.runId`,
 * and registers a response-finish hook to close the run with the
 * appropriate status. Inbound `x-run-id` (parentRunId) is preserved
 * separately on `req.parentRunId`.
 *
 * Caller MUST run `requireOrgId` first.
 */
export function withRunTracking(taskName: string) {
  return async function runTracking(req: Request, res: Response, next: NextFunction) {
    if (!req.orgId) {
      return res.status(500).json({ error: "withRunTracking requires requireOrgId first" });
    }

    const forward: ForwardHeaders = {};
    if (req.campaignId) forward.campaignId = req.campaignId;
    if (req.featureSlug) forward.featureSlug = req.featureSlug;
    if (req.brandIdHeader) forward.brandId = req.brandIdHeader;
    if (req.workflowSlug) forward.workflowSlug = req.workflowSlug;

    let run;
    try {
      run = await createRun(
        taskName,
        { orgId: req.orgId, userId: req.userId, parentRunId: req.parentRunId },
        forward,
      );
    } catch (err) {
      console.error(
        `[ai-visibility-score-service] runs-service unavailable — failing request:`,
        err,
      );
      return res
        .status(502)
        .json({ error: "Run tracking service unavailable. Please retry." });
    }

    req.runId = run.id;

    let closed = false;
    const closeRun = async () => {
      if (closed) return;
      closed = true;
      const status: "completed" | "failed" = res.statusCode >= 400 ? "failed" : "completed";
      try {
        await updateRunStatus(
          run.id,
          status,
          { orgId: req.orgId!, userId: req.userId, parentRunId: req.parentRunId },
          forward,
        );
      } catch (err) {
        console.error(
          `[ai-visibility-score-service] failed to close run ${run.id}:`,
          err,
        );
      }
    };

    res.on("finish", closeRun);
    res.on("close", closeRun);

    return next();
  };
}
