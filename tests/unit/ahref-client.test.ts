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
  brandId: "33333333-3333-4333-8333-333333333333",
};

const payload = {
  domain: "acme.com",
  snapshotDate: "2026-06-01",
  fetchedFromCache: true,
  mentionsTotal: 1234,
  mentionsByEngine: [{ engine: "chatgpt", mentions: 800 }],
  topCompetitors: [{ brand: "Rival", domain: "rival.com", citations: 512 }],
  raw: { foo: "bar" },
};

describe("fetchAhrefAiVisibility", () => {
  it("POSTs to ahref-service with correct url, headers, body, and an abort signal", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    });

    const { fetchAhrefAiVisibility } = await import("../../src/lib/ahref-client.js");
    const result = await fetchAhrefAiVisibility("acme.com", tracking);

    expect(result).toEqual(payload);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://ahref.test.local/orgs/domains/ai-visibility");
    expect(call[1].method).toBe("POST");

    const headers = call[1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-ahref-key");
    expect(headers["x-org-id"]).toBe(tracking.orgId);
    expect(headers["x-run-id"]).toBe(tracking.runId);
    expect(headers["x-brand-id"]).toBe(tracking.brandId);
    expect(headers["Content-Type"]).toBe("application/json");

    expect(JSON.parse(call[1].body)).toEqual({ domain: "acme.com" });
    // Fetch is bounded so a cold-cache scrape can never hang the run.
    expect(call[1].signal).toBeDefined();
  });

  it("throws on non-2xx response with status in error message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("upstream error"),
    });

    const { fetchAhrefAiVisibility } = await import("../../src/lib/ahref-client.js");
    await expect(fetchAhrefAiVisibility("acme.com", tracking)).rejects.toThrow(/502/);
  });

  it("throws if AHREF_SERVICE_URL not set", async () => {
    const original = process.env.AHREF_SERVICE_URL;
    delete process.env.AHREF_SERVICE_URL;
    try {
      const { fetchAhrefAiVisibility } = await import("../../src/lib/ahref-client.js");
      await expect(fetchAhrefAiVisibility("acme.com", tracking)).rejects.toThrow(
        /AHREF_SERVICE_URL/,
      );
    } finally {
      process.env.AHREF_SERVICE_URL = original;
    }
  });

  it("throws if AHREF_SERVICE_API_KEY not set", async () => {
    const original = process.env.AHREF_SERVICE_API_KEY;
    delete process.env.AHREF_SERVICE_API_KEY;
    try {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      });
      const { fetchAhrefAiVisibility } = await import("../../src/lib/ahref-client.js");
      await expect(fetchAhrefAiVisibility("acme.com", tracking)).rejects.toThrow(
        /AHREF_SERVICE_API_KEY/,
      );
    } finally {
      process.env.AHREF_SERVICE_API_KEY = original;
    }
  });
});
