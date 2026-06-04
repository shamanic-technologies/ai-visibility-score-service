import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn(),
}));

vi.mock("../../src/lib/chat-client.js", () => ({
  chatComplete: vi.fn(),
}));

vi.mock("../../src/lib/prompt-gen.js", () => ({
  generatePrompts: vi.fn(),
  SYSTEM_PROMPT: "MOCK_SYSTEM_PROMPT",
}));

vi.mock("../../src/lib/prompt-cache.js", () => ({
  cacheLookup: vi.fn(),
  cacheWrite: vi.fn(),
  computeSystemPromptHash: vi.fn().mockReturnValue("mock-hash"),
}));

vi.mock("../../src/lib/extractor.js", () => ({
  extractFromResponse: vi.fn(),
}));

vi.mock("../../src/lib/ahref-snapshot.js", () => ({
  fetchAhrefSnapshotSafe: vi.fn(),
  persistAhrefSnapshot: vi.fn(),
}));

import { runVisibilityScore } from "../../src/lib/run.js";
import { db } from "../../src/db/index.js";
import { extractBrandFields } from "../../src/lib/brand-client.js";
import { chatComplete } from "../../src/lib/chat-client.js";
import { generatePrompts } from "../../src/lib/prompt-gen.js";
import { cacheLookup, cacheWrite } from "../../src/lib/prompt-cache.js";
import { extractFromResponse } from "../../src/lib/extractor.js";
import { fetchAhrefSnapshotSafe, persistAhrefSnapshot } from "../../src/lib/ahref-snapshot.js";

const AHREF_DATA = {
  domain: "acme.com",
  snapshotDate: "2026-06-01",
  fetchedFromCache: true,
  mentionsTotal: 1234,
  mentionsByEngine: [{ engine: "chatgpt", mentions: 800 }],
  topCompetitors: [{ brand: "Rival", domain: "rival.com", citations: 512 }],
  raw: { foo: "bar" },
};

const AHREF_RESULT = {
  id: "snap-1",
  status: "completed" as const,
  domain: "acme.com",
  snapshotDate: "2026-06-01",
  fetchedFromCache: true,
  mentionsTotal: 1234,
  mentionsByEngine: AHREF_DATA.mentionsByEngine,
  topCompetitors: AHREF_DATA.topCompetitors,
  error: null,
  createdAt: "2026-06-04T00:00:00.000Z",
};

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const BRAND_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const opts = {
  brandId: BRAND_ID,
  orgId: ORG_ID,
  runId: RUN_ID,
  judges: [
    { provider: "google" as const, model: "flash" as const },
    { provider: "anthropic" as const, model: "sonnet" as const },
  ],
  promptGenProvider: "google" as const,
  promptGenModel: "pro" as const,
  extractionProvider: "google" as const,
  extractionModel: "pro" as const,
  nPrompts: 2,
  weights: {
    brandMentionRate: 0.25,
    citationRate: 0.15,
    positionScore: 0.2,
    shareOfVoice: 0.2,
    sentiment: 0.15,
    brandAndUrlRate: 0.05,
  },
};

function mockBrandSuccess() {
  vi.mocked(extractBrandFields).mockResolvedValue({
    brands: [
      {
        brandId: BRAND_ID,
        domain: "acme.com",
        name: "Acme",
      },
    ],
    fields: {
      category: { value: "saas crm vertical" },
      specific_offerings: { value: "free plan, paid plan" },
      target_audience: { value: "smb founders" },
      primary_geography: { value: "us" },
      positioning: { value: "no-code crm" },
    },
  });
}

function captureInsertedRow() {
  const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
  vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
  return valuesSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cacheLookup).mockResolvedValue(null);
  vi.mocked(cacheWrite).mockResolvedValue(undefined);
  vi.mocked(fetchAhrefSnapshotSafe).mockResolvedValue({ status: "completed", data: AHREF_DATA });
  vi.mocked(persistAhrefSnapshot).mockResolvedValue(AHREF_RESULT);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runVisibilityScore — failure persistence", () => {
  it("inserts a failed aggregate row when ALL judges fail", async () => {
    mockBrandSuccess();
    vi.mocked(generatePrompts).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-pg",
      userMessage: "user-pg",
    });
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockRejectedValue(new Error("chat-service 502"));

    const valuesSpy = captureInsertedRow();

    await expect(runVisibilityScore(opts)).rejects.toThrow(/all judges failed/);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.judgeKind).toBe("aggregate");
    expect(inserted.aggregateRunId).toBeNull();
    expect(inserted.llmProvider).toBe("aggregate");
    expect(inserted.llmModel).toBe("google/flash,anthropic/sonnet");
    expect(inserted.orgId).toBe(ORG_ID);
    expect(inserted.brandId).toBe(BRAND_ID);
    expect(inserted.runId).toBe(RUN_ID);
    expect(inserted.domain).toBe("acme.com");
    expect(inserted.brandName).toBe("Acme");
    expect(inserted.startedAt).toBeInstanceOf(Date);
    expect(inserted.completedAt).toBeInstanceOf(Date);
  });

  it("inserts a failed aggregate row with null brand info when brand-fetch throws", async () => {
    vi.mocked(extractBrandFields).mockRejectedValue(new Error("brand-service down"));

    const valuesSpy = captureInsertedRow();

    await expect(runVisibilityScore(opts)).rejects.toThrow("brand-service down");

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.judgeKind).toBe("aggregate");
    expect(inserted.error).toBe("brand-service down");
    expect(inserted.orgId).toBe(ORG_ID);
    expect(inserted.brandId).toBe(BRAND_ID);
    expect(inserted.domain).toBeNull();
    expect(inserted.brandName).toBeNull();
  });

  it("does not call db.insert via the failure path on success (transaction handles it)", async () => {
    mockBrandSuccess();
    vi.mocked(generatePrompts).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-pg",
      userMessage: "user-pg",
    });
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockResolvedValue({
      extraction: {
        brandFound: true,
        brandCount: 1,
        brandPosition: 1,
        urlFound: false,
        urlCount: 0,
        maxBrandsInResponse: 1,
        sentiment: "positive",
        sentimentScore: 0.5,
        citationUrls: [],
        competitors: [],
      },
      systemPrompt: "sys-ext",
      userMessage: "user-ext",
    });

    vi.mocked(db.transaction).mockResolvedValue({
      parentRow: { id: "x" },
      judgeRuns: [],
    } as any);

    await runVisibilityScore(opts);

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("propagates the original error even if failure-row insert itself throws", async () => {
    vi.mocked(extractBrandFields).mockRejectedValue(new Error("brand-service down"));
    vi.mocked(db.insert).mockImplementation(() => {
      throw new Error("DB disconnected");
    });

    await expect(runVisibilityScore(opts)).rejects.toThrow("brand-service down");
  });

  it("throws when opts.judges is empty (fail loud, no silent default)", async () => {
    await expect(
      runVisibilityScore({ ...opts, judges: [] }),
    ).rejects.toThrow(/at least one judge is required/);
  });
});

describe("runVisibilityScore — prompt cache", () => {
  function mockSuccessPath() {
    mockBrandSuccess();
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockResolvedValue({
      extraction: {
        brandFound: true,
        brandCount: 1,
        brandPosition: 1,
        urlFound: false,
        urlCount: 0,
        maxBrandsInResponse: 1,
        sentiment: "positive",
        sentimentScore: 0.5,
        citationUrls: [],
        competitors: [],
      },
      systemPrompt: "sys-ext",
      userMessage: "user-ext",
    });
    vi.mocked(db.transaction).mockResolvedValue({
      parentRow: { id: "x" },
      judgeRuns: [],
    } as any);
  }

  it("calls generatePrompts and writes to cache on miss", async () => {
    mockSuccessPath();
    vi.mocked(cacheLookup).mockResolvedValue(null);
    vi.mocked(generatePrompts).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-pg",
      userMessage: "user-pg",
    });

    await runVisibilityScore(opts);

    expect(generatePrompts).toHaveBeenCalledTimes(1);
    expect(cacheWrite).toHaveBeenCalledTimes(1);
    const writeArg = vi.mocked(cacheWrite).mock.calls[0][0];
    expect(writeArg.brandId).toBe(BRAND_ID);
    expect(writeArg.nPrompts).toBe(2);
    expect(writeArg.promptGenProvider).toBe("google");
    expect(writeArg.promptGenModel).toBe("pro");
    expect(writeArg.prompts).toEqual(["q1", "q2"]);
    expect(writeArg.systemPrompt).toBe("sys-pg");
    expect(writeArg.userMessage).toBe("user-pg");
  });

  it("skips generatePrompts when cache hit", async () => {
    mockSuccessPath();
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["cached1", "cached2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });

    await runVisibilityScore(opts);

    expect(generatePrompts).not.toHaveBeenCalled();
    expect(cacheWrite).not.toHaveBeenCalled();
  });
});

describe("runVisibilityScore — judge grounding", () => {
  it("calls every judge with webSearch:true (panel is web-grounded)", async () => {
    mockBrandSuccess();
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockResolvedValue({
      extraction: {
        brandFound: true,
        brandCount: 1,
        brandPosition: 1,
        urlFound: false,
        urlCount: 0,
        maxBrandsInResponse: 1,
        sentiment: "positive",
        sentimentScore: 0.5,
        citationUrls: [],
        competitors: [],
      },
      systemPrompt: "sys-ext",
      userMessage: "user-ext",
    });
    vi.mocked(db.transaction).mockResolvedValue({
      parentRow: { id: "x" },
      judgeRuns: [],
    } as any);

    await runVisibilityScore(opts);

    // 2 judges × 2 prompts = 4 judge calls — chatComplete in run.ts is judge-only.
    expect(chatComplete).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(chatComplete).mock.calls) {
      expect(call[0].webSearch).toBe(true);
    }
  });
});

describe("runVisibilityScore — ahref snapshot", () => {
  function mockSuccessPath() {
    mockBrandSuccess();
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockResolvedValue({
      extraction: {
        brandFound: true,
        brandCount: 1,
        brandPosition: 1,
        urlFound: false,
        urlCount: 0,
        maxBrandsInResponse: 1,
        sentiment: "positive",
        sentimentScore: 0.5,
        citationUrls: [],
        competitors: [],
      },
      systemPrompt: "sys-ext",
      userMessage: "user-ext",
    });
    vi.mocked(db.transaction).mockResolvedValue({
      parentRow: { id: "x" },
      judgeRuns: [],
    } as any);
  }

  it("fetches Ahrefs for the brand domain and persists the snapshot linked to the aggregate run", async () => {
    mockSuccessPath();

    const result = await runVisibilityScore(opts);

    expect(fetchAhrefSnapshotSafe).toHaveBeenCalledTimes(1);
    expect(fetchAhrefSnapshotSafe).toHaveBeenCalledWith(
      "acme.com",
      expect.objectContaining({ orgId: ORG_ID, runId: RUN_ID, brandId: BRAND_ID }),
    );

    expect(persistAhrefSnapshot).toHaveBeenCalledTimes(1);
    const persistArgs = vi.mocked(persistAhrefSnapshot).mock.calls[0];
    expect(persistArgs[0]).toMatchObject({
      domain: "acme.com",
      brandName: "Acme",
      aggregateRunId: "x",
      orgId: ORG_ID,
      runId: RUN_ID,
    });
    expect(persistArgs[1]).toEqual({ status: "completed", data: AHREF_DATA });

    expect(result.ahrefs).toEqual(AHREF_RESULT);
  });

  it("run succeeds (no throw) and returns a failed snapshot when the Ahrefs fetch fails", async () => {
    mockSuccessPath();
    vi.mocked(fetchAhrefSnapshotSafe).mockResolvedValue({ status: "failed", error: "ahref down" });
    const failedSnapshot = { ...AHREF_RESULT, status: "failed" as const, error: "ahref down" };
    vi.mocked(persistAhrefSnapshot).mockResolvedValue(failedSnapshot);

    const result = await runVisibilityScore(opts);

    expect(persistAhrefSnapshot).toHaveBeenCalledWith(expect.anything(), {
      status: "failed",
      error: "ahref down",
    });
    expect(result.ahrefs?.status).toBe("failed");
  });
});
