import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const identity = { orgId: "org-1", userId: "user-1", parentRunId: "parent-run-1" };

describe("runs-client", () => {
  it("createRun POSTs to /v1/runs with identity headers and serviceName", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-x", serviceName: "ai-visibility-score-service", taskName: "t", status: "running" }),
    });

    const { createRun } = await import("../../src/lib/runs-client.js");
    const r = await createRun("visibility-score-run", identity);
    expect(r.id).toBe("run-x");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://runs.test.local/v1/runs");
    const headers = call[1].headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-run-id"]).toBe("parent-run-1");
    const body = JSON.parse(call[1].body);
    expect(body.serviceName).toBe("ai-visibility-score-service");
    expect(body.taskName).toBe("visibility-score-run");
  });

  it("updateRunStatus PATCHes /v1/runs/:id with status", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-x", status: "completed" }),
    });
    const { updateRunStatus } = await import("../../src/lib/runs-client.js");
    await updateRunStatus("run-x", "completed", identity);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].method).toBe("PATCH");
    expect(JSON.parse(call[1].body)).toEqual({ status: "completed" });
  });

  it("throws on non-2xx", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("boom"),
    });
    const { createRun } = await import("../../src/lib/runs-client.js");
    await expect(createRun("t", identity)).rejects.toThrow(/returned 500/);
  });
});
