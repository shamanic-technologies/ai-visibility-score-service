import { describe, it, expect } from "vitest";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../../src/schemas.js";

describe("openapi generation", () => {
  const doc = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.0",
    info: { title: "test", version: "0.0.0" },
  });

  it("includes /health", () => {
    expect(doc.paths?.["/health"]?.get).toBeDefined();
  });

  it("includes /openapi.json", () => {
    expect(doc.paths?.["/openapi.json"]?.get).toBeDefined();
  });

  it("includes POST /orgs/visibility-score-runs", () => {
    expect(doc.paths?.["/orgs/visibility-score-runs"]?.post).toBeDefined();
  });

  it("includes GET /orgs/visibility-score-runs", () => {
    expect(doc.paths?.["/orgs/visibility-score-runs"]?.get).toBeDefined();
  });

  it("includes GET /orgs/visibility-score-runs/{id}", () => {
    expect(doc.paths?.["/orgs/visibility-score-runs/{id}"]?.get).toBeDefined();
  });

  it("registers VisibilityScoreRunRequest component", () => {
    expect(doc.components?.schemas?.["VisibilityScoreRunRequest"]).toBeDefined();
  });
});
