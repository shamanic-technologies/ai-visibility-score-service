import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tracking = {
  orgId: "00000000-0000-0000-0000-00000000aaaa",
  runId: "00000000-0000-0000-0000-00000000bbbb",
  brandId: "00000000-0000-0000-0000-00000000cccc",
};

describe("extractFromResponse", () => {
  it("returns parsed structured result when chat-service returns valid JSON", async () => {
    const payload = {
      brandFound: true,
      brandCount: 2,
      brandPosition: 1,
      urlFound: true,
      urlCount: 1,
      maxBrandsInResponse: 3,
      sentiment: "positive",
      sentimentScore: 0.7,
      citationUrls: ["https://acme.com/a"],
      competitors: [
        { name: "B", url: "https://b.com", position: 2, sentiment: "neutral", sentimentScore: 0, citationUrl: null },
      ],
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: JSON.stringify(payload), tokensInput: 10, tokensOutput: 5, model: "haiku-1", json: payload }),
    });

    const { extractFromResponse } = await import("../../src/lib/extractor.js");
    const out = await extractFromResponse({
      responseText: "Acme is good",
      brandName: "Acme",
      domain: "acme.com",
      provider: "anthropic",
      model: "haiku",
      tracking,
    });

    expect(out.brandFound).toBe(true);
    expect(out.brandPosition).toBe(1);
    expect(out.competitors).toHaveLength(1);
  });

  it("recovers from JSON wrapped in prose if `json` field absent", async () => {
    const payload = {
      brandFound: false,
      brandCount: 0,
      brandPosition: null,
      urlFound: false,
      urlCount: 0,
      maxBrandsInResponse: 1,
      sentiment: "neutral",
      sentimentScore: 0,
      citationUrls: [],
      competitors: [],
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: `here is the result:\n${JSON.stringify(payload)}\nthat is all.`,
          tokensInput: 10,
          tokensOutput: 5,
          model: "haiku-1",
        }),
    });

    const { extractFromResponse } = await import("../../src/lib/extractor.js");
    const out = await extractFromResponse({
      responseText: "no acme here",
      brandName: "Acme",
      domain: "acme.com",
      provider: "anthropic",
      model: "haiku",
      tracking,
    });
    expect(out.brandFound).toBe(false);
  });

  it("rejects when response fails the schema", async () => {
    const bad = { brandFound: "yes" }; // wrong types
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: JSON.stringify(bad), json: bad, tokensInput: 1, tokensOutput: 1, model: "x" }),
    });

    const { extractFromResponse } = await import("../../src/lib/extractor.js");
    await expect(
      extractFromResponse({
        responseText: "x",
        brandName: "Acme",
        domain: "acme.com",
        provider: "anthropic",
        model: "haiku",
        tracking,
      }),
    ).rejects.toThrow();
  });
});
