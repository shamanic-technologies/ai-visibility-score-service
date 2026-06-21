import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireOrgId } from "../../src/middleware/auth.js";

/**
 * Regression guard for per-audience cost attribution (x-audience-id propagation).
 *
 * Asserts the full chain the brief requires: an inbound `x-audience-id` tracking
 * header is captured on the request identity AND re-forwarded on every INTERNAL
 * egress call (runs / chat / brand / ahref clients). If any link drops the header,
 * the run/cost rows fall into the "non-attribué" bucket and the per-audience CPC
 * goes wrong — this test fails loud before that ships again.
 */

const VALID_ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const VALID_AUDIENCE = "33333333-3333-4333-8333-333333333333";
const VALID_RUN = "22222222-2222-4222-8222-222222222222";
const VALID_BRAND = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function mocks(headers: Record<string, string> = {}) {
  const req = { headers } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe("x-audience-id inbound capture", () => {
  it("sets req.audienceId when x-audience-id is a valid UUID", () => {
    const { req, res, next } = mocks({ "x-org-id": VALID_ORG, "x-audience-id": VALID_AUDIENCE });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.audienceId).toBe(VALID_AUDIENCE);
  });

  it("ignores a non-UUID x-audience-id (stays undefined, never throws)", () => {
    const { req, res, next } = mocks({ "x-org-id": VALID_ORG, "x-audience-id": "not-a-uuid" });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.audienceId).toBeUndefined();
  });

  it("leaves req.audienceId undefined when header absent (off-campaign)", () => {
    const { req, res, next } = mocks({ "x-org-id": VALID_ORG });
    requireOrgId(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.audienceId).toBeUndefined();
  });
});

describe("x-audience-id internal egress forwarding", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastHeaders(): Record<string, string> {
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    return call[1].headers as Record<string, string>;
  }

  it("runs-client createRun forwards x-audience-id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-x", serviceName: "ai-visibility-score-service", taskName: "t", status: "running" }),
    });
    const { createRun } = await import("../../src/lib/runs-client.js");
    await createRun("visibility-score-run", { orgId: VALID_ORG }, { audienceId: VALID_AUDIENCE });
    expect(lastHeaders()["x-audience-id"]).toBe(VALID_AUDIENCE);
  });

  it("chat-client chatComplete forwards x-audience-id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: "x", tokensInput: 1, tokensOutput: 1, model: "m" }),
    });
    const { chatComplete } = await import("../../src/lib/chat-client.js");
    await chatComplete(
      { message: "m", systemPrompt: "s", provider: "anthropic", model: "haiku" },
      { orgId: VALID_ORG, runId: VALID_RUN, audienceId: VALID_AUDIENCE },
    );
    expect(lastHeaders()["x-audience-id"]).toBe(VALID_AUDIENCE);
  });

  it("brand-client extractBrandFields forwards x-audience-id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ brands: [], fields: {} }),
    });
    const { extractBrandFields } = await import("../../src/lib/brand-client.js");
    await extractBrandFields(
      [{ key: "k", description: "d" }],
      { orgId: VALID_ORG, runId: VALID_RUN, brandId: VALID_BRAND, audienceId: VALID_AUDIENCE },
    );
    expect(lastHeaders()["x-audience-id"]).toBe(VALID_AUDIENCE);
  });

  it("ahref-client fetchAhrefAiVisibility forwards x-audience-id", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ domain: "d.com", snapshotDate: null, fetchedFromCache: false, mentionsTotal: 0, mentionsByEngine: [], topCompetitors: [], raw: {} }),
    });
    const { fetchAhrefAiVisibility } = await import("../../src/lib/ahref-client.js");
    await fetchAhrefAiVisibility(
      "d.com",
      { orgId: VALID_ORG, runId: VALID_RUN, brandId: VALID_BRAND, audienceId: VALID_AUDIENCE },
    );
    expect(lastHeaders()["x-audience-id"]).toBe(VALID_AUDIENCE);
  });

  it("runs-client omits x-audience-id when absent (off-campaign, never sends empty)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-x", serviceName: "ai-visibility-score-service", taskName: "t", status: "running" }),
    });
    const { createRun } = await import("../../src/lib/runs-client.js");
    await createRun("visibility-score-run", { orgId: VALID_ORG });
    expect(lastHeaders()["x-audience-id"]).toBeUndefined();
  });
});
