import { describe, it, expect } from "vitest";
import { assertEnv } from "../../src/index.js";

describe("assertEnv", () => {
  const FULL = {
    AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL: "postgres://x",
    AI_VISIBILITY_SCORE_SERVICE_API_KEY: "k",
    CHAT_SERVICE_URL: "u",
    CHAT_SERVICE_API_KEY: "k",
    BRAND_SERVICE_URL: "u",
    BRAND_SERVICE_API_KEY: "k",
    RUNS_SERVICE_URL: "u",
    RUNS_SERVICE_API_KEY: "k",
    AHREF_SERVICE_URL: "u",
    AHREF_SERVICE_API_KEY: "k",
  } as NodeJS.ProcessEnv;

  it("does not throw when all required env present", () => {
    expect(() => assertEnv(FULL)).not.toThrow();
  });

  it("throws listing missing var when one absent", () => {
    const partial = { ...FULL };
    delete partial.AI_VISIBILITY_SCORE_SERVICE_API_KEY;
    expect(() => assertEnv(partial)).toThrow(/AI_VISIBILITY_SCORE_SERVICE_API_KEY/);
  });

  it("throws listing all missing vars", () => {
    expect(() => assertEnv({} as NodeJS.ProcessEnv)).toThrow(
      /AI_VISIBILITY_SCORE_SERVICE_DATABASE_URL.*AI_VISIBILITY_SCORE_SERVICE_API_KEY/,
    );
  });
});
