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
  const VALID_ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const VALID_USER = "11111111-2222-3333-4444-555555555555";
  const VALID_BRAND_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const VALID_BRAND_B = "12345678-1234-1234-1234-123456789abc";

  it("400 when x-org-id missing", () => {
    const { req, res, next } = mocks();
    requireOrgId(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("400 when x-org-id is not a valid UUID", () => {
    const { req, res, next } = mocks({ "x-org-id": "not-a-uuid" });
    requireOrgId(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when x-org-id is a valid UUID", () => {
    const { req, res, next } = mocks({ "x-org-id": VALID_ORG });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.orgId).toBe(VALID_ORG);
  });

  it("ignores non-UUID x-user-id (req.userId stays undefined)", () => {
    const { req, res, next } = mocks({ "x-org-id": VALID_ORG, "x-user-id": "not-a-uuid" });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.userId).toBeUndefined();
  });

  it("sets req.userId when valid UUID", () => {
    const { req, res, next } = mocks({ "x-org-id": VALID_ORG, "x-user-id": VALID_USER });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe(VALID_USER);
  });

  it("filters out non-UUID entries from x-brand-id", () => {
    const { req, res, next } = mocks({
      "x-org-id": VALID_ORG,
      "x-brand-id": `${VALID_BRAND_A}, not-valid, ${VALID_BRAND_B}`,
    });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.brandIds).toEqual([VALID_BRAND_A, VALID_BRAND_B]);
  });

  it("400 when x-brand-id has ALL invalid entries", () => {
    const { req, res, next } = mocks({
      "x-org-id": VALID_ORG,
      "x-brand-id": "bad1, bad2, bad3",
    });
    requireOrgId(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("populates req.brandIds from comma-separated x-brand-id with valid UUIDs", () => {
    const { req, res, next } = mocks({
      "x-org-id": VALID_ORG,
      "x-brand-id": `${VALID_BRAND_A}, ${VALID_BRAND_B}`,
    });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.brandIds).toEqual([VALID_BRAND_A, VALID_BRAND_B]);
    expect(req.orgId).toBe(VALID_ORG);
  });
});
