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
}));

vi.mock("../../src/lib/extractor.js", () => ({
  extractFromResponse: vi.fn(),
}));

import { runVisibilityScore } from "../../src/lib/run.js";
import { db } from "../../src/db/index.js";
import { extractBrandFields } from "../../src/lib/brand-client.js";
import { chatComplete } from "../../src/lib/chat-client.js";
import { generatePrompts } from "../../src/lib/prompt-gen.js";
import { extractFromResponse } from "../../src/lib/extractor.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const BRAND_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const opts = {
  brandId: BRAND_ID,
  orgId: ORG_ID,
  runId: RUN_ID,
  provider: "google" as const,
  promptModel: "pro" as const,
  promptGenProvider: "google" as const,
  promptGenModel: "flash" as const,
  extractionProvider: "anthropic" as const,
  extractionModel: "haiku" as const,
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
      industry: { value: "saas" },
      target_audience: { value: "smb" },
      offerings: { value: "thing" },
      geography: { value: "us" },
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runVisibilityScore — failure persistence", () => {
  it("inserts a failed row when extractor throws (brand info known)", async () => {
    mockBrandSuccess();
    vi.mocked(generatePrompts).mockResolvedValue(["q1", "q2"]);
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockRejectedValue(new Error("chat-service 502"));

    const valuesSpy = captureInsertedRow();

    await expect(runVisibilityScore(opts)).rejects.toThrow("chat-service 502");

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.error).toBe("chat-service 502");
    expect(inserted.orgId).toBe(ORG_ID);
    expect(inserted.brandId).toBe(BRAND_ID);
    expect(inserted.runId).toBe(RUN_ID);
    expect(inserted.domain).toBe("acme.com");
    expect(inserted.brandName).toBe("Acme");
    expect(inserted.startedAt).toBeInstanceOf(Date);
    expect(inserted.completedAt).toBeInstanceOf(Date);
  });

  it("inserts a failed row with null brand info when brand-fetch throws", async () => {
    vi.mocked(extractBrandFields).mockRejectedValue(new Error("brand-service down"));

    const valuesSpy = captureInsertedRow();

    await expect(runVisibilityScore(opts)).rejects.toThrow("brand-service down");

    expect(db.insert).toHaveBeenCalledTimes(1);
    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.error).toBe("brand-service down");
    expect(inserted.orgId).toBe(ORG_ID);
    expect(inserted.brandId).toBe(BRAND_ID);
    expect(inserted.domain).toBeNull();
    expect(inserted.brandName).toBeNull();
  });

  it("does not call db.insert via the failure path on success (transaction handles it)", async () => {
    mockBrandSuccess();
    vi.mocked(generatePrompts).mockResolvedValue(["q1", "q2"]);
    vi.mocked(chatComplete).mockResolvedValue({
      content: "answer",
      tokensInput: 1,
      tokensOutput: 1,
    });
    vi.mocked(extractFromResponse).mockResolvedValue({
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
    });

    vi.mocked(db.transaction).mockResolvedValue({
      runRow: { id: "x" },
      promptRows: [],
      competitorRows: [],
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
});
