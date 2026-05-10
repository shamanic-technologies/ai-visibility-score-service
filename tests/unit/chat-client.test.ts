import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tracking = {
  orgId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
};

describe("chatComplete", () => {
  it("sends POST to chat-service with correct body and headers", async () => {
    const chatResult = {
      content: "Hello world",
      tokensInput: 10,
      tokensOutput: 5,
      model: "haiku-1",
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(chatResult),
    });

    const { chatComplete } = await import("../../src/lib/chat-client.js");
    const result = await chatComplete(
      {
        message: "test prompt",
        systemPrompt: "You are helpful.",
        provider: "anthropic",
        model: "haiku",
        responseFormat: "json",
        temperature: 0.5,
        maxTokens: 1000,
      },
      tracking,
    );

    expect(result).toEqual(chatResult);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://chat.test.local/complete");
    expect(call[1].method).toBe("POST");

    const headers = call[1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-chat-key");
    expect(headers["x-org-id"]).toBe(tracking.orgId);
    expect(headers["x-run-id"]).toBe(tracking.runId);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      message: "test prompt",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "haiku",
      responseFormat: "json",
      temperature: 0.5,
      maxTokens: 1000,
    });
  });

  it("throws on non-2xx response with status in error message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve("service unavailable"),
    });

    const { chatComplete } = await import("../../src/lib/chat-client.js");
    await expect(
      chatComplete(
        { message: "m", systemPrompt: "s", provider: "google", model: "flash" },
        tracking,
      ),
    ).rejects.toThrow(/503/);
  });

  it("throws if CHAT_SERVICE_URL not set", async () => {
    const original = process.env.CHAT_SERVICE_URL;
    delete process.env.CHAT_SERVICE_URL;
    try {
      const { chatComplete } = await import("../../src/lib/chat-client.js");
      await expect(
        chatComplete(
          { message: "m", systemPrompt: "s", provider: "google", model: "flash" },
          tracking,
        ),
      ).rejects.toThrow(/CHAT_SERVICE_URL/);
    } finally {
      process.env.CHAT_SERVICE_URL = original;
    }
  });

  it("throws if CHAT_SERVICE_API_KEY not set", async () => {
    const original = process.env.CHAT_SERVICE_API_KEY;
    delete process.env.CHAT_SERVICE_API_KEY;
    try {
      const { chatComplete } = await import("../../src/lib/chat-client.js");
      await expect(
        chatComplete(
          { message: "m", systemPrompt: "s", provider: "google", model: "flash" },
          tracking,
        ),
      ).rejects.toThrow(/CHAT_SERVICE_API_KEY/);
    } finally {
      process.env.CHAT_SERVICE_API_KEY = original;
    }
  });
});
