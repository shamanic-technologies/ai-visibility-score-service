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
          model: "flash-1",
        }),
    });

    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    const out = await generatePrompts(
      { industry: "saas", target_audience: "founders", offerings: "crm", geography: "us" },
      5,
      { model: "flash", tracking },
    );

    expect(out).toEqual(prompts);
    expect(out).toHaveLength(5);
  });

  it("throws if model returns fewer prompts than requested", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: JSON.stringify({ prompts: ["a", "b"] }),
          json: { prompts: ["a", "b"] },
          tokensInput: 10,
          tokensOutput: 5,
          model: "flash-1",
        }),
    });

    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    await expect(generatePrompts({}, 5, { model: "flash", tracking })).rejects.toThrow(/returned 2/);
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
          model: "flash-1",
        }),
    });

    const { generatePrompts } = await import("../../src/lib/prompt-gen.js");
    const out = await generatePrompts({}, 3, { model: "flash", tracking });
    expect(out).toEqual(prompts);
  });
});
