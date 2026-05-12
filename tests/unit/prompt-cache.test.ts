import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

import { computeSystemPromptHash, cacheLookup, cacheWrite, CACHE_TTL_DAYS } from "../../src/lib/prompt-cache.js";
import { db } from "../../src/db/index.js";

const BRAND_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeSystemPromptHash", () => {
  it("is deterministic for same input", () => {
    expect(computeSystemPromptHash("hello world")).toBe(computeSystemPromptHash("hello world"));
  });

  it("differs for different input", () => {
    expect(computeSystemPromptHash("a")).not.toBe(computeSystemPromptHash("b"));
  });

  it("returns a sha256 hex string", () => {
    const h = computeSystemPromptHash("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

function mockSelectReturning(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as any);
  return { from, where, limit };
}

describe("cacheLookup", () => {
  const key = {
    brandId: BRAND_ID,
    nPrompts: 25,
    promptGenProvider: "google",
    promptGenModel: "pro",
    systemPromptHash: "abc123",
  };

  it("returns null when no row matches", async () => {
    mockSelectReturning([]);
    const result = await cacheLookup(key);
    expect(result).toBeNull();
  });

  it("returns cached payload when fresh row exists", async () => {
    mockSelectReturning([
      {
        prompts: ["q1", "q2"],
        systemPrompt: "sys",
        userMessage: "user",
      },
    ]);
    const result = await cacheLookup(key);
    expect(result).toEqual({
      prompts: ["q1", "q2"],
      systemPrompt: "sys",
      userMessage: "user",
    });
  });
});

describe("cacheWrite", () => {
  it("inserts a row with expires_at = now + 30 days", async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);

    const before = Date.now();
    await cacheWrite({
      brandId: BRAND_ID,
      nPrompts: 25,
      promptGenProvider: "google",
      promptGenModel: "pro",
      systemPromptHash: "h",
      systemPrompt: "sys",
      userMessage: "user",
      prompts: ["a", "b"],
    });
    const after = Date.now();

    expect(valuesSpy).toHaveBeenCalledTimes(1);
    const row = valuesSpy.mock.calls[0][0];
    expect(row.brandId).toBe(BRAND_ID);
    expect(row.nPrompts).toBe(25);
    expect(row.promptGenProvider).toBe("google");
    expect(row.promptGenModel).toBe("pro");
    expect(row.systemPromptHash).toBe("h");
    expect(row.systemPrompt).toBe("sys");
    expect(row.userMessage).toBe("user");
    expect(row.prompts).toEqual(["a", "b"]);

    const expiry = row.expiresAt.getTime();
    const expectedMin = before + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(expiry).toBeGreaterThanOrEqual(expectedMin);
    expect(expiry).toBeLessThanOrEqual(expectedMax);
  });
});
