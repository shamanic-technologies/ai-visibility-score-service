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

describe("extractBrandFields", () => {
  it("sends POST to brand-service with correct headers and returns parsed JSON", async () => {
    const responsePayload = {
      brandId: tracking.brandId,
      fields: { industry: "saas", target_audience: "founders" },
      brand: { id: tracking.brandId, name: "Acme", domain: "acme.com" },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responsePayload),
    });

    const { extractBrandFields } = await import("../../src/lib/brand-client.js");
    const fields = [{ key: "industry", description: "The brand industry" }];
    const result = await extractBrandFields(fields, tracking);

    expect(result).toEqual(responsePayload);

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://brand.test.local/orgs/brands/extract-fields");
    expect(call[1].method).toBe("POST");

    const headers = call[1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-brand-key");
    expect(headers["x-org-id"]).toBe(tracking.orgId);
    expect(headers["x-run-id"]).toBe(tracking.runId);
    expect(headers["x-brand-id"]).toBe(tracking.brandId);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ fields });
  });

  it("throws on non-2xx response with status in error message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("upstream error"),
    });

    const { extractBrandFields } = await import("../../src/lib/brand-client.js");
    await expect(
      extractBrandFields([{ key: "k", description: "d" }], tracking),
    ).rejects.toThrow(/502/);
  });

  it("throws if BRAND_SERVICE_URL not set", async () => {
    const original = process.env.BRAND_SERVICE_URL;
    delete process.env.BRAND_SERVICE_URL;
    try {
      const { extractBrandFields } = await import("../../src/lib/brand-client.js");
      await expect(
        extractBrandFields([{ key: "k", description: "d" }], tracking),
      ).rejects.toThrow(/BRAND_SERVICE_URL/);
    } finally {
      process.env.BRAND_SERVICE_URL = original;
    }
  });

  it("throws if BRAND_SERVICE_API_KEY not set", async () => {
    const original = process.env.BRAND_SERVICE_API_KEY;
    delete process.env.BRAND_SERVICE_API_KEY;
    try {
      const { extractBrandFields } = await import("../../src/lib/brand-client.js");
      await expect(
        extractBrandFields([{ key: "k", description: "d" }], tracking),
      ).rejects.toThrow(/BRAND_SERVICE_API_KEY/);
    } finally {
      process.env.BRAND_SERVICE_API_KEY = original;
    }
  });
});
