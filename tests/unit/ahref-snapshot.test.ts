import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/ahref-client.js", () => ({
  fetchAhrefAiVisibility: vi.fn(),
  DEFAULT_AHREF_TIMEOUT_MS: 60_000,
}));

vi.mock("../../src/db/index.js", () => ({
  db: { insert: vi.fn() },
}));

import {
  fetchAhrefSnapshotSafe,
  persistAhrefSnapshot,
} from "../../src/lib/ahref-snapshot.js";
import { fetchAhrefAiVisibility } from "../../src/lib/ahref-client.js";
import { db } from "../../src/db/index.js";

const tracking = {
  orgId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  brandId: "33333333-3333-4333-8333-333333333333",
};

const data = {
  domain: "acme.com",
  snapshotDate: "2026-06-01",
  fetchedFromCache: true,
  mentionsTotal: 1234,
  mentionsByEngine: [{ engine: "chatgpt", mentions: 800 }],
  topCompetitors: [{ brand: "Rival", domain: "rival.com", citations: 512 }],
  raw: { foo: "bar" },
};

const params = {
  orgId: tracking.orgId,
  brandId: tracking.brandId,
  runId: tracking.runId,
  aggregateRunId: "44444444-4444-4444-8444-444444444444",
  domain: "acme.com",
  brandName: "Acme",
};

function captureInsert(returnedRow: Record<string, unknown>) {
  const valuesSpy = vi
    .fn()
    .mockReturnValue({ returning: vi.fn().mockResolvedValue([returnedRow]) });
  vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
  return valuesSpy;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchAhrefSnapshotSafe", () => {
  it("returns a completed outcome on success", async () => {
    vi.mocked(fetchAhrefAiVisibility).mockResolvedValue(data);
    const outcome = await fetchAhrefSnapshotSafe("acme.com", tracking);
    expect(outcome).toEqual({ status: "completed", data });
  });

  it("returns a failed outcome (never throws) when the client throws", async () => {
    vi.mocked(fetchAhrefAiVisibility).mockRejectedValue(new Error("ahref 502"));
    const outcome = await fetchAhrefSnapshotSafe("acme.com", tracking);
    expect(outcome).toEqual({ status: "failed", error: "ahref 502" });
  });
});

describe("persistAhrefSnapshot", () => {
  const createdAt = new Date("2026-06-04T00:00:00.000Z");

  it("inserts a completed row with raw + breakdowns and returns the serialized snapshot", async () => {
    const valuesSpy = captureInsert({
      id: "snap1",
      status: "completed",
      domain: "acme.com",
      snapshotDate: "2026-06-01",
      fetchedFromCache: true,
      mentionsTotal: 1234,
      mentionsByEngine: data.mentionsByEngine,
      topCompetitors: data.topCompetitors,
      error: null,
      createdAt,
    });

    const result = await persistAhrefSnapshot(params, { status: "completed", data });

    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("completed");
    expect(inserted.aggregateRunId).toBe(params.aggregateRunId);
    expect(inserted.domain).toBe("acme.com");
    expect(inserted.brandName).toBe("Acme");
    expect(inserted.mentionsTotal).toBe(1234);
    expect(inserted.mentionsByEngine).toEqual(data.mentionsByEngine);
    expect(inserted.topCompetitors).toEqual(data.topCompetitors);
    expect(inserted.raw).toEqual(data.raw);
    expect(inserted.error).toBeNull();

    expect(result?.id).toBe("snap1");
    expect(result?.status).toBe("completed");
    expect(result?.mentionsTotal).toBe(1234);
    expect(result?.createdAt).toBe(createdAt.toISOString());
  });

  it("inserts a failed row carrying the error (null metrics)", async () => {
    const valuesSpy = captureInsert({
      id: "snap2",
      status: "failed",
      domain: "acme.com",
      snapshotDate: null,
      fetchedFromCache: null,
      mentionsTotal: null,
      mentionsByEngine: null,
      topCompetitors: null,
      error: "ahref 502",
      createdAt,
    });

    const result = await persistAhrefSnapshot(params, { status: "failed", error: "ahref 502" });

    const inserted = valuesSpy.mock.calls[0][0];
    expect(inserted.status).toBe("failed");
    expect(inserted.error).toBe("ahref 502");
    expect(inserted.mentionsTotal).toBeNull();
    expect(inserted.raw).toBeNull();

    expect(result?.status).toBe("failed");
    expect(result?.error).toBe("ahref 502");
  });

  it("returns null and does not throw when db.insert fails", async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      throw new Error("DB down");
    });
    const result = await persistAhrefSnapshot(params, { status: "completed", data });
    expect(result).toBeNull();
  });
});
