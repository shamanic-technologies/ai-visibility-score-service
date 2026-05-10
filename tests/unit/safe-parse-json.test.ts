import { describe, it, expect } from "vitest";
import { safeParseJson } from "../../src/lib/safe-parse-json.js";

describe("safeParseJson", () => {
  it("parses a valid JSON string", () => {
    const obj = { key: "value", num: 42 };
    const result = safeParseJson(JSON.stringify(obj), "test");
    expect(result).toEqual(obj);
  });

  it("extracts and parses JSON wrapped in prose", () => {
    const obj = { brandFound: true, score: 0.85 };
    const wrapped = `Sure, here is the result:\n${JSON.stringify(obj)}\nHope that helps!`;
    const result = safeParseJson(wrapped, "test");
    expect(result).toEqual(obj);
  });

  it("throws with label in message when no braces found", () => {
    expect(() => safeParseJson("just plain text", "myLabel")).toThrow(/myLabel/);
  });

  it("throws on empty string", () => {
    expect(() => safeParseJson("", "empty")).toThrow();
  });
});
