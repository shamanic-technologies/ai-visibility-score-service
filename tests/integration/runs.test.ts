import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import request from "supertest";

// Mock DB to avoid real connections in integration tests
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  client: {},
}));

// Mock the orchestrator so we don't actually call external services
vi.mock("../../src/lib/run.js", () => ({
  runVisibilityScore: vi.fn(),
}));

// Mock runs-client so withRunTracking middleware is exercised but doesn't hit network
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(),
  updateRunStatus: vi.fn(),
}));

import { createApp } from "../../src/index.js";
import { runVisibilityScore } from "../../src/lib/run.js";
import { createRun, updateRunStatus } from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const BRAND_ID_1 = "22222222-2222-4222-8222-222222222222";
const BRAND_ID_2 = "33333333-3333-4333-8333-333333333333";
const PARENT_RUN = "44444444-4444-4444-8444-444444444444";
const SVC_RUN = "55555555-5555-4555-8555-555555555555";

function authHeaders(extra: Record<string, string> = {}) {
  return {
    "x-api-key": "test-internal-key",
    "x-org-id": ORG_ID,
    "x-user-id": "user-1",
    "x-run-id": PARENT_RUN,
    ...extra,
  };
}

beforeAll(() => {
  process.env.NODE_ENV = "test";
});

beforeEach(() => {
  vi.mocked(createRun).mockResolvedValue({
    id: SVC_RUN,
    serviceName: "ai-visibility-score-service",
    taskName: "t",
    status: "running",
  });
  vi.mocked(updateRunStatus).mockResolvedValue({
    id: SVC_RUN,
    serviceName: "ai-visibility-score-service",
    taskName: "t",
    status: "completed",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// Flattens a Drizzle SQL/column tree into a string containing every column
// name referenced. Avoids JSON.stringify, which chokes on Drizzle's circular
// table↔column back-references.
function serializeFilter(node: unknown, seen = new WeakSet<object>()): string {
  if (node === null || node === undefined) return "";
  if (typeof node !== "object") return String(node);
  if (seen.has(node as object)) return "";
  seen.add(node as object);
  const obj = node as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.name === "string") parts.push(obj.name);
  if (Array.isArray(obj.queryChunks)) {
    for (const c of obj.queryChunks) parts.push(serializeFilter(c, seen));
  }
  for (const k of ["left", "right", "value", "table", "column"]) {
    if (k in obj) parts.push(serializeFilter(obj[k], seen));
  }
  return parts.join(" ");
}

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "ai-visibility-score-service" });
  });
});

describe("auth + validation on POST /orgs/visibility-score-runs", () => {
  it("401 without x-api-key", async () => {
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .send({});
    expect(res.status).toBe(401);
  });

  it("403 with wrong x-api-key", async () => {
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set({ ...authHeaders({ "x-brand-id": BRAND_ID_1 }), "x-api-key": "wrong" })
      .send({});
    expect(res.status).toBe(403);
  });

  it("400 without x-org-id", async () => {
    const h = authHeaders({ "x-brand-id": BRAND_ID_1 });
    delete (h as Record<string, string>)["x-org-id"];
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(h)
      .send({});
    expect(res.status).toBe(400);
  });

  it("400 when x-brand-id missing", async () => {
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/x-brand-id/);
  });

  it("400 when x-brand-id is not a valid UUID", async () => {
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": "not-a-uuid" }))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UUID/);
  });

  it("400 when body contains any field (strict)", async () => {
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({ nPrompts: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });

  it("502 when runs-service unavailable", async () => {
    vi.mocked(createRun).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({});
    expect(res.status).toBe(502);
  });
});

describe("happy path POST /orgs/visibility-score-runs", () => {
  function fakeResult(brandId: string) {
    return {
      run: {
        id: `run-${brandId}`,
        orgId: ORG_ID,
        brandId,
        parentRunId: PARENT_RUN,
        runId: SVC_RUN,
        aggregateRunId: null,
        judgeKind: "aggregate" as const,
        domain: "acme.com",
        brandName: "Acme",
        llmProvider: "aggregate",
        llmModel: "google/pro,anthropic/opus",
        promptGenModel: "flash",
        extractionProvider: "google",
        extractionModel: "pro",
        nPrompts: 25,
        weights: {
          brandMentionRate: 0.25,
          citationRate: 0.15,
          positionScore: 0.2,
          shareOfVoice: 0.2,
          sentiment: 0.15,
          brandAndUrlRate: 0.05,
        },
        brandMentionCount: 10,
        brandMentionRate: "0.4000",
        urlMentionCount: 5,
        urlMentionRate: "0.2000",
        brandAndUrlCount: 5,
        brandAndUrlRate: "0.2000",
        avgPosition: "1.50",
        positionScore: "0.7500",
        shareOfVoice: "0.3500",
        weightedShareOfVoice: "0.4000",
        citationCount: 5,
        citationRate: "0.2000",
        citationShareOfVoice: "0.2500",
        positiveCount: 7,
        neutralCount: 2,
        negativeCount: 1,
        netSentiment: "0.6000",
        avgSentimentScore: "0.5000",
        avgResponseLength: 300,
        responseLengthWhenBrandFound: 320,
        responseLengthWhenBrandNotFound: 280,
        distinctCompetitorsCount: 12,
        visibilityScore: "47.50",
        status: "completed" as const,
        error: null,
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
      },
      byProvider: [],
      metrics: {
        brand_mention_count: 10,
        brand_mention_rate: 0.4,
        url_mention_count: 5,
        url_mention_rate: 0.2,
        brand_and_url_count: 5,
        brand_and_url_rate: 0.2,
        avg_position: 1.5,
        position_score: 0.75,
        share_of_voice: 0.35,
        weighted_share_of_voice: 0.4,
        citation_count: 5,
        citation_rate: 0.2,
        citation_share_of_voice: 0.25,
        citation_opportunities: [{ domain: "competitor.com", count: 3 }],
        positive_count: 7,
        neutral_count: 2,
        negative_count: 1,
        net_sentiment: 0.6,
        avg_sentiment_score: 0.5,
        avg_response_length: 300,
        response_length_when_brand_found: 320,
        response_length_when_brand_not_found: 280,
        distinct_competitors_count: 12,
        top_competitors: [],
        visibility_score: 0.475,
      },
    };
  }

  it("returns one result for one brand with empty body", async () => {
    vi.mocked(runVisibilityScore).mockResolvedValueOnce(fakeResult(BRAND_ID_1) as any);
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].run.brandId).toBe(BRAND_ID_1);
    expect(res.body.results[0].citation_opportunities[0].domain).toBe("competitor.com");
  });

  it("calls runVisibilityScore with server-side config values", async () => {
    vi.mocked(runVisibilityScore).mockResolvedValueOnce(fakeResult(BRAND_ID_1) as any);
    await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({});

    const callArg = vi.mocked(runVisibilityScore).mock.calls[0][0];
    expect(callArg.judges).toEqual([
      { provider: "google", model: "flash" },
      { provider: "anthropic", model: "sonnet" },
    ]);
    expect(callArg.promptGenProvider).toBe("google");
    expect(callArg.promptGenModel).toBe("flash");
    expect(callArg.extractionProvider).toBe("google");
    expect(callArg.extractionModel).toBe("flash");
    expect(callArg.nPrompts).toBe(25);
    expect(callArg.brandId).toBe(BRAND_ID_1);
  });

  it("returns by_provider array with one entry per configured judge", async () => {
    const fr = fakeResult(BRAND_ID_1);
    (fr as any).byProvider = [
      {
        judge: { provider: "google", model: "pro" },
        run: { ...fr.run, id: "child-google", aggregateRunId: fr.run.id, judgeKind: "per_provider" as const, llmProvider: "google", llmModel: "pro" },
        prompts: [],
        competitors: [],
        metrics: { ...fr.metrics, top_competitors: [], citation_opportunities: [] },
      },
      {
        judge: { provider: "anthropic", model: "opus" },
        run: { ...fr.run, id: "child-opus", aggregateRunId: fr.run.id, judgeKind: "per_provider" as const, llmProvider: "anthropic", llmModel: "opus" },
        prompts: [],
        competitors: [],
        metrics: { ...fr.metrics, top_competitors: [], citation_opportunities: [] },
      },
    ];
    vi.mocked(runVisibilityScore).mockResolvedValueOnce(fr as any);
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.results[0].by_provider).toHaveLength(2);
    expect(res.body.results[0].by_provider[0].provider).toBe("google");
    expect(res.body.results[0].by_provider[0].model).toBe("pro");
    expect(res.body.results[0].by_provider[1].provider).toBe("anthropic");
    expect(res.body.results[0].by_provider[1].model).toBe("opus");
  });

  it("rejects multi-brand x-brand-id header with 400", async () => {
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": `${BRAND_ID_1},${BRAND_ID_2}` }))
      .send({});

    expect(res.status).toBe(400);
    expect(vi.mocked(runVisibilityScore)).not.toHaveBeenCalled();
  });

  it("forwards parentRunId from inbound x-run-id and uses own runId in createRun call", async () => {
    vi.mocked(runVisibilityScore).mockResolvedValueOnce(fakeResult(BRAND_ID_1) as any);
    await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({});

    expect(vi.mocked(createRun)).toHaveBeenCalledWith(
      "visibility-score-run",
      expect.objectContaining({ parentRunId: PARENT_RUN, orgId: ORG_ID }),
      expect.any(Object),
    );

    const callArg = vi.mocked(runVisibilityScore).mock.calls[0][0];
    expect(callArg.runId).toBe(SVC_RUN);
    expect(callArg.parentRunId).toBe(PARENT_RUN);
  });

  it("returns 500 if the brand run fails", async () => {
    vi.mocked(runVisibilityScore).mockRejectedValue(new Error("brand-service down"));
    const res = await request(createApp())
      .post("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }))
      .send({});
    expect(res.status).toBe(500);
  });
});

describe("GET /orgs/visibility-score-runs (list)", () => {
  it("returns runs list with pagination", async () => {
    const now = new Date();
    const mockRow = {
      r: {
        id: BRAND_ID_1,
        orgId: ORG_ID,
        brandId: BRAND_ID_1,
        parentRunId: PARENT_RUN,
        runId: SVC_RUN,
        aggregateRunId: null,
        judgeKind: "aggregate" as const,
        domain: "acme.com",
        brandName: "Acme",
        llmProvider: "aggregate",
        llmModel: "google/pro,anthropic/opus",
        promptGenModel: "flash",
        extractionProvider: "google",
        extractionModel: "pro",
        nPrompts: 25,
        weights: {
          brandMentionRate: 0.25,
          citationRate: 0.15,
          positionScore: 0.2,
          shareOfVoice: 0.2,
          sentiment: 0.15,
          brandAndUrlRate: 0.05,
        },
        brandMentionCount: 10,
        brandMentionRate: "0.4000",
        urlMentionCount: 5,
        urlMentionRate: "0.2000",
        brandAndUrlCount: 5,
        brandAndUrlRate: "0.2000",
        avgPosition: "1.50",
        positionScore: "0.7500",
        shareOfVoice: "0.3500",
        weightedShareOfVoice: "0.4000",
        citationCount: 5,
        citationRate: "0.2000",
        citationShareOfVoice: "0.2500",
        positiveCount: 7,
        neutralCount: 2,
        negativeCount: 1,
        netSentiment: "0.6000",
        avgSentimentScore: "0.5000",
        avgResponseLength: 300,
        responseLengthWhenBrandFound: 320,
        responseLengthWhenBrandNotFound: 280,
        distinctCompetitorsCount: 12,
        visibilityScore: "0.4750",
        status: "completed" as const,
        error: null,
        startedAt: now,
        completedAt: now,
        createdAt: now,
      },
      visibility_score_delta: "0.05",
      share_of_voice_delta: null,
      net_sentiment_delta: "0.1",
      position_delta: null,
    };

    const offset = vi.fn().mockResolvedValue([mockRow]);
    const limitFn = vi.fn(() => ({ offset }));
    const orderBy = vi.fn(() => ({ limit: limitFn }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as any);

    const res = await request(createApp())
      .get("/orgs/visibility-score-runs")
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("runs");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].brandId).toBe(BRAND_ID_1);
    expect(res.body.runs[0].visibility_score_delta).toBe("0.05");
  });

  it("accepts campaignId filter and returns 200", async () => {
    const CAMPAIGN_ID = "66666666-6666-4666-8666-666666666666";
    const offset = vi.fn().mockResolvedValue([]);
    const limitFn = vi.fn(() => ({ offset }));
    const orderBy = vi.fn(() => ({ limit: limitFn }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as any);

    const res = await request(createApp())
      .get(`/orgs/visibility-score-runs?brandId=${BRAND_ID_1}&campaignId=${CAMPAIGN_ID}`)
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }));

    expect(res.status).toBe(200);
    expect(where).toHaveBeenCalledTimes(1);
    // and(...filters) is the single argument to where(); inspect its query chunks
    // to confirm a campaign_id reference participated in the filter.
    const whereArg = where.mock.calls[0][0];
    expect(serializeFilter(whereArg)).toContain("campaign_id");
  });

  it("rejects invalid campaignId with 400", async () => {
    const res = await request(createApp())
      .get(`/orgs/visibility-score-runs?campaignId=not-a-uuid`)
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid query");
  });

  it("omits campaign_id filter when query param absent", async () => {
    const offset = vi.fn().mockResolvedValue([]);
    const limitFn = vi.fn(() => ({ offset }));
    const orderBy = vi.fn(() => ({ limit: limitFn }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as any);

    const res = await request(createApp())
      .get(`/orgs/visibility-score-runs?brandId=${BRAND_ID_1}`)
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }));

    expect(res.status).toBe(200);
    expect(serializeFilter(where.mock.calls[0][0])).not.toContain("campaign_id");
  });
});

describe("GET /orgs/visibility-score-runs/:id", () => {
  it("returns 404 when run belongs to another org", async () => {
    const where = vi.fn().mockResolvedValue([]); // no row matches org filter
    const from = vi.fn(() => ({ where }));
    vi.mocked(db.select).mockReturnValue({ from } as any);

    const res = await request(createApp())
      .get(`/orgs/visibility-score-runs/${BRAND_ID_1}`)
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }));

    expect(res.status).toBe(404);
  });

  it("returns aggregate run + by_provider array", async () => {
    const now = new Date();
    const PARENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const CHILD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const PROMPT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    function makeRun(overrides: Record<string, unknown>) {
      return {
        id: PARENT_ID,
        orgId: ORG_ID,
        brandId: BRAND_ID_1,
        parentRunId: PARENT_RUN,
        runId: SVC_RUN,
        aggregateRunId: null,
        judgeKind: "aggregate",
        domain: "acme.com",
        brandName: "Acme",
        llmProvider: "aggregate",
        llmModel: "google/pro,anthropic/opus",
        promptGenModel: "flash",
        extractionProvider: "google",
        extractionModel: "pro",
        nPrompts: 1,
        weights: {
          brandMentionRate: 0.25,
          citationRate: 0.15,
          positionScore: 0.2,
          shareOfVoice: 0.2,
          sentiment: 0.15,
          brandAndUrlRate: 0.05,
        },
        brandMentionCount: 1,
        brandMentionRate: "1.0000",
        urlMentionCount: 0,
        urlMentionRate: "0.0000",
        brandAndUrlCount: 0,
        brandAndUrlRate: "0.0000",
        avgPosition: "1.00",
        positionScore: "1.0000",
        shareOfVoice: "1.0000",
        weightedShareOfVoice: "1.0000",
        citationCount: 0,
        citationRate: "0.0000",
        citationShareOfVoice: "0.0000",
        positiveCount: 1,
        neutralCount: 0,
        negativeCount: 0,
        netSentiment: "1.0000",
        avgSentimentScore: "0.8000",
        avgResponseLength: 200,
        responseLengthWhenBrandFound: 200,
        responseLengthWhenBrandNotFound: null,
        distinctCompetitorsCount: 0,
        visibilityScore: "0.8000",
        promptGenSystemPrompt: "prompt-gen system prompt",
        promptGenUserMessage: "prompt-gen user message with category: saas",
        status: "completed" as const,
        error: null,
        startedAt: now,
        completedAt: now,
        createdAt: now,
        ...overrides,
      };
    }

    const fakeParent = makeRun({});
    const fakeChild = makeRun({
      id: CHILD_ID,
      aggregateRunId: PARENT_ID,
      judgeKind: "per_provider",
      llmProvider: "google",
      llmModel: "pro",
    });

    const fakePrompt = {
      id: PROMPT_ID,
      runIdFk: CHILD_ID,
      orgId: ORG_ID,
      promptIndex: 0,
      promptText: "best CRM for early stage startups",
      judgeSystemPrompt: "",
      judgeUserMessage: "best CRM for early stage startups",
      extractorSystemPrompt: "extractor sys prompt",
      extractorUserMessage: "Target brand:\n- name: Acme\n- domain: acme.com\n\nLLM response to analyze:\n\"\"\"\nAcme is a great company.\n\"\"\"",
      responseText: "Acme is a great company.",
      responseLengthChars: 24,
      brandFound: true,
      brandCount: 1,
      brandPosition: 1,
      urlFound: false,
      urlCount: 0,
      brandAndUrlCoOccurrence: false,
      maxBrandsInResponse: 1,
      sentiment: "positive",
      sentimentScore: "0.8000",
      citationUrls: [],
      latencyMs: 500,
      tokensInput: 50,
      tokensOutput: 30,
      createdAt: now,
    };

    // The handler now calls db.select() multiple times:
    // 1. lookup requested row (parent), 2. lookup children, 3. child prompts, 4. child competitors
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const where = vi.fn().mockResolvedValue([fakeParent]);
        const from = vi.fn(() => ({ where }));
        return { from } as any;
      } else if (callCount === 2) {
        const where = vi.fn().mockResolvedValue([fakeChild]);
        const from = vi.fn(() => ({ where }));
        return { from } as any;
      } else if (callCount === 3) {
        const where = vi.fn().mockResolvedValue([fakePrompt]);
        const from = vi.fn(() => ({ where }));
        return { from } as any;
      } else {
        const where = vi.fn().mockResolvedValue([]);
        const from = vi.fn(() => ({ where }));
        return { from } as any;
      }
    });

    const res = await request(createApp())
      .get(`/orgs/visibility-score-runs/${PARENT_ID}`)
      .set(authHeaders({ "x-brand-id": BRAND_ID_1 }));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("run");
    expect(res.body).toHaveProperty("by_provider");
    expect(res.body).toHaveProperty("top_competitors");
    expect(res.body).toHaveProperty("citation_opportunities");
    expect(res.body.run.id).toBe(PARENT_ID);
    expect(res.body.run.judgeKind).toBe("aggregate");
    expect(res.body.by_provider).toHaveLength(1);
    expect(res.body.by_provider[0].provider).toBe("google");
    expect(res.body.by_provider[0].model).toBe("pro");
    expect(res.body.by_provider[0].prompts).toHaveLength(1);
    expect(res.body.by_provider[0].prompts[0].promptText).toBe("best CRM for early stage startups");

    // Debug payload exposure: judge + extractor + prompt-gen prompts must be returned verbatim.
    const promptRow = res.body.by_provider[0].prompts[0];
    expect(promptRow.judgeSystemPrompt).toBe("");
    expect(promptRow.judgeUserMessage).toBe("best CRM for early stage startups");
    // The judge user message MUST equal the prompt text — server injects nothing.
    expect(promptRow.judgeUserMessage).toBe(promptRow.promptText);
    expect(promptRow.judgeUserMessage).not.toContain("Acme");
    expect(promptRow.judgeUserMessage).not.toContain("acme.com");
    expect(promptRow.extractorSystemPrompt).toBe("extractor sys prompt");
    expect(promptRow.extractorUserMessage).toContain("Target brand:");
    expect(promptRow.extractorUserMessage).toContain("name: Acme");
    expect(promptRow.extractorUserMessage).toContain("domain: acme.com");

    expect(res.body.run.promptGenSystemPrompt).toBe("prompt-gen system prompt");
    expect(res.body.run.promptGenUserMessage).toContain("category: saas");
  });
});
