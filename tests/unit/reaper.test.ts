import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: vi.fn(),
  },
}));

import { reapStaleRuns, STUCK_RUN_THRESHOLD_MS } from "../../src/lib/reaper.js";
import { db } from "../../src/db/index.js";

// Mock a `db.update(...).set(...).where(...).returning(...)` chain.
function mockUpdate(rows: unknown[], opts: { reject?: boolean } = {}) {
  const setSpy = vi.fn();
  const whereSpy = vi.fn();
  const chain: any = {
    set: (v: unknown) => {
      setSpy(v);
      return chain;
    },
    where: (w: unknown) => {
      whereSpy(w);
      return chain;
    },
    returning: () => (opts.reject ? Promise.reject(new Error("DB down")) : Promise.resolve(rows)),
  };
  vi.mocked(db.update).mockReturnValue(chain);
  return { setSpy, whereSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reapStaleRuns", () => {
  it("flips stuck 'running' rows to 'failed' and returns the count", async () => {
    const { setSpy } = mockUpdate([{ id: "r1" }, { id: "r2" }]);

    const count = await reapStaleRuns(new Date("2026-06-04T12:00:00.000Z"));

    expect(count).toBe(2);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const setArg = setSpy.mock.calls[0][0];
    expect(setArg.status).toBe("failed");
    expect(setArg.error).toMatch(/reaper/i);
    expect(setArg.completedAt).toBeInstanceOf(Date);
  });

  it("returns 0 when no run is stuck", async () => {
    mockUpdate([]);

    const count = await reapStaleRuns();

    expect(count).toBe(0);
  });

  it("has a generous threshold (30 min)", () => {
    expect(STUCK_RUN_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });

  it("propagates a DB failure (fail loud — caller is on a live request path)", async () => {
    mockUpdate([], { reject: true });
    await expect(reapStaleRuns()).rejects.toThrow("DB down");
  });
});
