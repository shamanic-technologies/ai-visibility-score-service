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

describe("SYSTEM_PROMPT", () => {
  it("contains all required v2 sections", async () => {
    const { SYSTEM_PROMPT } = await import("../../src/lib/prompt-gen.js");
    expect(SYSTEM_PROMPT).toContain("VENDOR-CITABLE QUERIES ONLY");
    expect(SYSTEM_PROMPT).toContain("NICHE GROUNDING");
    expect(SYSTEM_PROMPT).toContain("NEUTRALITY");
    expect(SYSTEM_PROMPT).toContain("INTENT MIX");
    expect(SYSTEM_PROMPT).toContain("COMPARISON BUCKET");
    expect(SYSTEM_PROMPT).toContain("STYLE");
    expect(SYSTEM_PROMPT).toContain("DO NOT");
  });
});

describe("buildUserMessage", () => {
  it("includes all 5 brand context fields", async () => {
    const { buildUserMessage } = await import("../../src/lib/prompt-gen.js");
    const msg = buildUserMessage(
      {
        category: "Portuguese Golden Visa advisory",
        specific_offerings: "500K Fund Route, 200K Cultural Donation, D7 Visa",
        target_audience: "US HNW families seeking EU residency",
        primary_geography: "Delivered from Portugal; serves US clients",
        positioning: "Portuguese-licensed independent advisory firm since 2012",
      },
      25,
    );
    expect(msg).toContain("category: Portuguese Golden Visa advisory");
    expect(msg).toContain("specific offerings: 500K Fund Route");
    expect(msg).toContain("target audience: US HNW families seeking EU residency");
    expect(msg).toContain("primary geography: Delivered from Portugal");
    expect(msg).toContain("positioning: Portuguese-licensed independent advisory firm since 2012");
    expect(msg).toContain("Return exactly 25 prompts");
  });

  it("falls back to (unknown) for missing fields", async () => {
    const { buildUserMessage } = await import("../../src/lib/prompt-gen.js");
    const msg = buildUserMessage({}, 10);
    expect(msg).toContain("category: (unknown)");
    expect(msg).toContain("specific offerings: (unknown)");
    expect(msg).toContain("target audience: (unknown)");
    expect(msg).toContain("primary geography: (unknown)");
    expect(msg).toContain("positioning: (unknown)");
  });
});

describe("generatePrompts", () => {
  it("returns N strings parsed from chat-service JSON", async () => {
    const prompts = Array.from({ length: 5 }, (_, i) => `query ${i + 1}`);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: JSON.stringify({ prompts }),
          json: { prompts },
          tokensInput: 10,
          tokensOutput: 30,
          model: "pro-1",
        }),
    });

    const { generatePrompts, SYSTEM_PROMPT } = await import("../../src/lib/prompt-gen.js");
    const out = await generatePrompts(
      {
        category: "saas vertical",
        specific_offerings: "crm, billing",
        target_audience: "founders",
        primary_geography: "us",
        positioning: "no-code, free tier",
      },
      5,
      { provider: "google", model: "pro", tracking },
    );

    expect(out.prompts).toEqual(prompts);
    expect(out.prompts).toHaveLength(5);
    expect(out.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(out.userMessage).toContain("category: saas vertical");
    expect(out.userMessage).toContain("specific offerings: crm, billing");
    expect(out.userMessage).toContain("target audience: founders");
    expect(out.userMessage).toContain("primary geography: us");
    expect(out.userMessage).toContain("positioning: no-code, free tier");
  });

  it("throws if model returns fewer prompts than requested (strict, no relax)", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: JSON.stringify({ prompts: ["a", "b"] }),
          json: { prompts: ["a", "b"] },
          tokensInput: 10,
          tokensOutput: 5,
          model: "pro-1",
        }),
    });

    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    await expect(
      generatePrompts({}, 5, { provider: "google", model: "pro", tracking }),
    ).rejects.toThrow(/returned 2/);
  });

  it("slices to exactly N when model returns more", async () => {
    const prompts = Array.from({ length: 30 }, (_, i) => `q${i}`);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: JSON.stringify({ prompts }),
          json: { prompts },
          tokensInput: 10,
          tokensOutput: 30,
          model: "pro-1",
        }),
    });
    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    const out = await generatePrompts({}, 25, { provider: "google", model: "pro", tracking });
    expect(out.prompts).toHaveLength(25);
    expect(out.prompts[0]).toBe("q0");
    expect(out.prompts[24]).toBe("q24");
  });

  it("recovers from JSON wrapped in prose", async () => {
    const prompts = ["a", "b", "c"];
    const wrapped = `Sure thing: ${JSON.stringify({ prompts })} done.`;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: wrapped,
          tokensInput: 10,
          tokensOutput: 5,
          model: "pro-1",
        }),
    });

    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    const out = await generatePrompts({}, 3, { provider: "google", model: "pro", tracking });
    expect(out.prompts).toEqual(prompts);
  });

  it("forwards provider+model to chat-service unchanged", async () => {
    const prompts = ["a"];
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: JSON.stringify({ prompts }),
          json: { prompts },
          tokensInput: 1,
          tokensOutput: 1,
          model: "sonnet-1",
        }),
    });

    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    await generatePrompts({}, 1, { provider: "anthropic", model: "sonnet", tracking });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("sonnet");
  });
});
