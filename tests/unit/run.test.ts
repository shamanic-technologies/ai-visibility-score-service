import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    select: vi.fn(),
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
const PARENT_DB_ID = "parent-x";

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

const okExtraction = {
  extraction: {
    brandFound: true,
    brandCount: 1,
    brandPosition: 1,
    urlFound: false,
    urlCount: 0,
    maxBrandsInResponse: 1,
    sentiment: "positive" as const,
    sentimentScore: 0.5,
    citationUrls: [],
    competitors: [],
  },
  systemPrompt: "sys-ext",
  userMessage: "user-ext",
};

// Capture the values passed to the single `db.insert` (the `running` parent row).
function mockParentInsert() {
  const valuesSpy = vi
    .fn()
    .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: PARENT_DB_ID }]) });
  vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
  return valuesSpy;
}

// Capture every `db.update(...).set(...)` argument (brand stamp + terminal flip). Supports
// both `await update().set().where()` (brand stamp) and `await update().set().where().returning()`
// (terminal flip → [parentRow]).
function mockUpdate(returnRow: Record<string, unknown> = { id: PARENT_DB_ID, status: "completed" }) {
  const setSpy = vi.fn();
  const chain: any = {
    set: (v: unknown) => {
      setSpy(v);
      return chain;
    },
    where: () => chain,
    returning: () => Promise.resolve([returnRow]),
    then: (onF: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve([returnRow]).then(onF, onR),
  };
  vi.mocked(db.update).mockReturnValue(chain);
  return setSpy;
}

// Per-judge transaction: each call runs the callback against a tx whose inserts resolve to
// a 1-element row array (enough for the child-row id + prompt rows).
function mockJudgeTransactions() {
  const tx = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "child-x" }]) }),
    }),
  };
  vi.mocked(db.transaction).mockImplementation((cb: any) => cb(tx));
  return tx;
}

// Chainable + thenable stand-in for a drizzle select builder.
function selectChain(result: unknown[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(result),
    then: (onF: (v: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR),
  };
  return chain;
}

// Full happy-path persistence stack: parent insert + updates + per-judge transactions.
function mockPersistence() {
  mockParentInsert();
  const setSpy = mockUpdate();
  mockJudgeTransactions();
  return setSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(cacheLookup).mockResolvedValue(null);
  vi.mocked(cacheWrite).mockResolvedValue(undefined);
  vi.mocked(fetchAhrefSnapshotSafe).mockResolvedValue({ status: "completed", data: AHREF_DATA });
  vi.mocked(persistAhrefSnapshot).mockResolvedValue(AHREF_RESULT);
  // Default: no recent completed run → 24h cache misses, full run proceeds.
  vi.mocked(db.select).mockReturnValue(selectChain([]));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runVisibilityScore — incremental persistence", () => {
  function mockFullSuccess() {
    mockBrandSuccess();
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    return mockPersistence();
  }

  it("inserts the parent row as 'running' BEFORE any judge call", async () => {
    const valuesSpy = mockParentInsert();
    mockUpdate();
    mockJudgeTransactions();
    mockBrandSuccess();
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);

    await runVisibilityScore(opts);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("running");
    expect(inserted.judgeKind).toBe("aggregate");
    expect(inserted.aggregateRunId).toBeNull();
    expect(inserted.llmProvider).toBe("aggregate");
    expect(inserted.llmModel).toBe("google/flash,anthropic/sonnet");
    expect(inserted.domain).toBeNull();
    expect(inserted.brandName).toBeNull();
    expect(inserted.startedAt).toBeInstanceOf(Date);
    // Parent row is written before the first grounded LLM call burns any tokens.
    const insertOrder = vi.mocked(db.insert).mock.invocationCallOrder[0];
    const firstJudgeOrder = vi.mocked(chatComplete).mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(firstJudgeOrder);
  });

  it("stamps the resolved brand onto the running row", async () => {
    const setSpy = mockFullSuccess();

    await runVisibilityScore(opts);

    // First update = brand stamp.
    expect(setSpy.mock.calls[0][0]).toEqual({ domain: "acme.com", brandName: "Acme" });
  });

  it("flips the parent to 'completed' with aggregate metrics on success", async () => {
    const setSpy = mockFullSuccess();

    await runVisibilityScore(opts);

    const completedSet = setSpy.mock.calls.find((c) => c[0].status === "completed");
    expect(completedSet).toBeDefined();
    expect(completedSet![0].completedAt).toBeInstanceOf(Date);
    expect(completedSet![0]).toHaveProperty("visibilityScore");
  });

  it("persists each judge in its own transaction (incremental checkpoint)", async () => {
    mockFullSuccess();

    await runVisibilityScore(opts);

    // One transaction per configured judge — committed independently as each finishes.
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
});

describe("runVisibilityScore — failure persistence", () => {
  it("flips the parent to 'failed' (no second insert) when ALL judges fail", async () => {
    mockBrandSuccess();
    vi.mocked(generatePrompts).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-pg",
      userMessage: "user-pg",
    });
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockRejectedValue(new Error("chat-service 502"));
    mockParentInsert();
    const setSpy = mockUpdate({ id: PARENT_DB_ID, status: "failed" });
    mockJudgeTransactions();

    await expect(runVisibilityScore(opts)).rejects.toThrow(/all judges failed/);

    // Parent inserted once (running); failure is an UPDATE, not a new insert.
    expect(db.insert).toHaveBeenCalledTimes(1);
    const failedSet = setSpy.mock.calls.find((c) => c[0].status === "failed");
    expect(failedSet).toBeDefined();
    expect(failedSet![0].error).toMatch(/all judges failed/);
    expect(failedSet![0].completedAt).toBeInstanceOf(Date);
  });

  it("flips the parent to 'failed' when brand-fetch throws, propagating the original error", async () => {
    vi.mocked(extractBrandFields).mockRejectedValue(new Error("brand-service down"));
    mockParentInsert();
    const setSpy = mockUpdate({ id: PARENT_DB_ID, status: "failed" });

    await expect(runVisibilityScore(opts)).rejects.toThrow("brand-service down");

    expect(db.insert).toHaveBeenCalledTimes(1);
    const failedSet = setSpy.mock.calls.find((c) => c[0].status === "failed");
    expect(failedSet).toBeDefined();
    expect(failedSet![0].error).toBe("brand-service down");
  });

  it("propagates the original error even if the failed-flip update itself throws", async () => {
    vi.mocked(extractBrandFields).mockRejectedValue(new Error("brand-service down"));
    mockParentInsert();
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error("DB disconnected");
    });

    await expect(runVisibilityScore(opts)).rejects.toThrow("brand-service down");
  });

  it("throws when opts.judges is empty (fail loud, no insert)", async () => {
    const valuesSpy = mockParentInsert();

    await expect(runVisibilityScore({ ...opts, judges: [] })).rejects.toThrow(
      /at least one judge is required/,
    );
    expect(valuesSpy).not.toHaveBeenCalled();
  });
});

describe("runVisibilityScore — prompt cache", () => {
  function mockSuccessPath() {
    mockBrandSuccess();
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    mockPersistence();
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
    expect(writeArg.prompts).toEqual(["q1", "q2"]);
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
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    mockPersistence();

    await runVisibilityScore(opts);

    // 2 judges × 2 prompts = 4 judge calls — chatComplete in run.ts is judge-only.
    expect(chatComplete).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(chatComplete).mock.calls) {
      expect(call[0].webSearch).toBe(true);
    }
  });
});

describe("runVisibilityScore — partial-failure tolerance", () => {
  function mockPromptsCached() {
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });
  }

  it("A — one failing prompt does NOT fail the whole judge; run still completes", async () => {
    mockBrandSuccess();
    mockPromptsCached();
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse)
      .mockRejectedValueOnce(new Error("chat-service 502"))
      .mockResolvedValue(okExtraction);
    const setSpy = mockPersistence();

    await runVisibilityScore(opts);

    // Reached the terminal completed flip = the run completed.
    expect(setSpy.mock.calls.some((c) => c[0].status === "completed")).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it("B — one provider fully down (all its prompts fail) → run still completes from the other", async () => {
    mockBrandSuccess();
    mockPromptsCached();
    vi.mocked(chatComplete).mockImplementation(async (params: any) => {
      if (params.provider === "anthropic") throw new Error("LLM call failed");
      return { content: "answer", tokensInput: 1, tokensOutput: 1 } as any;
    });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    const setSpy = mockPersistence();

    await runVisibilityScore(opts);

    expect(setSpy.mock.calls.some((c) => c[0].status === "completed")).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it("throws (failed run) only when EVERY provider is down", async () => {
    mockBrandSuccess();
    mockPromptsCached();
    vi.mocked(chatComplete).mockRejectedValue(new Error("LLM call failed"));
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    mockParentInsert();
    const setSpy = mockUpdate({ id: PARENT_DB_ID, status: "failed" });
    mockJudgeTransactions();

    await expect(runVisibilityScore(opts)).rejects.toThrow(/all judges failed/);
    expect(setSpy.mock.calls.some((c) => c[0].status === "failed")).toBe(true);
  });
});

describe("runVisibilityScore — 24h run cache", () => {
  const cachedParent = {
    id: "cached-run-id",
    orgId: ORG_ID,
    brandId: BRAND_ID,
    domain: "acme.com",
    weights: opts.weights,
    status: "completed" as const,
    createdAt: new Date("2026-06-04T00:00:00.000Z"),
  };

  it("serves the cached completed run and spends ZERO LLM tokens (no insert/update/tx)", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([cachedParent])) // findRecentCompletedRun → hit
      .mockReturnValueOnce(selectChain([])); // loadRunBundle children → none

    const result = await runVisibilityScore(opts);

    expect(result.run.id).toBe("cached-run-id");
    expect(extractBrandFields).not.toHaveBeenCalled();
    expect(generatePrompts).not.toHaveBeenCalled();
    expect(chatComplete).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("runs fresh on cache miss (no recent completed run)", async () => {
    mockBrandSuccess();
    vi.mocked(cacheLookup).mockResolvedValue({
      prompts: ["q1", "q2"],
      systemPrompt: "sys-cached",
      userMessage: "user-cached",
    });
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    mockPersistence();

    await runVisibilityScore(opts);

    expect(extractBrandFields).toHaveBeenCalledTimes(1);
    expect(chatComplete).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
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
    vi.mocked(chatComplete).mockResolvedValue({ content: "answer", tokensInput: 1, tokensOutput: 1 });
    vi.mocked(extractFromResponse).mockResolvedValue(okExtraction);
    mockPersistence();
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
      aggregateRunId: PARENT_DB_ID,
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
