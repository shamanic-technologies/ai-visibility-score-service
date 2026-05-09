import { describe, it, expect } from "vitest";
import { assertEnv } from "../../src/index.js";

describe("assertEnv", () => {
  const FULL = {
    DATABASE_URL: "postgres://x",
    INTERNAL_API_KEY: "k",
    CHAT_SERVICE_URL: "u",
    CHAT_SERVICE_API_KEY: "k",
    BRAND_SERVICE_URL: "u",
    BRAND_SERVICE_API_KEY: "k",
    RUNS_SERVICE_URL: "u",
    RUNS_SERVICE_API_KEY: "k",
  } as NodeJS.ProcessEnv;

  it("does not throw when all required env present", () => {
    expect(() => assertEnv(FULL)).not.toThrow();
  });

  it("throws listing missing var when one absent", () => {
    const partial = { ...FULL };
    delete partial.INTERNAL_API_KEY;
    expect(() => assertEnv(partial)).toThrow(/INTERNAL_API_KEY/);
  });

  it("throws listing all missing vars", () => {
    expect(() => assertEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL.*INTERNAL_API_KEY/);
  });
});
