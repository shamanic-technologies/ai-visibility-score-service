import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { apiKeyAuth, requireOrgId } from "../../src/middleware/auth.js";

function mocks(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe("apiKeyAuth", () => {
  it("401 when x-api-key missing", () => {
    process.env.AI_VISIBILITY_SCORE_SERVICE_API_KEY = "k";
    const { req, res, next } = mocks();
    apiKeyAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("403 when x-api-key wrong", () => {
    process.env.AI_VISIBILITY_SCORE_SERVICE_API_KEY = "right";
    const { req, res, next } = mocks({ "x-api-key": "wrong" });
    apiKeyAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("calls next when key matches", () => {
    process.env.AI_VISIBILITY_SCORE_SERVICE_API_KEY = "k";
    const { req, res, next } = mocks({ "x-api-key": "k" });
    apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("requireOrgId", () => {
  it("400 when x-org-id missing", () => {
    const { req, res, next } = mocks();
    requireOrgId(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("populates req.brandIds from comma-separated x-brand-id", () => {
    const req = {
      headers: {
        "x-org-id": "org-1",
        "x-brand-id": "b1, b2 ,b3",
      },
    } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    const next = vi.fn();
    requireOrgId(req, res, next as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(req.brandIds).toEqual(["b1", "b2", "b3"]);
    expect(req.orgId).toBe("org-1");
  });
});
