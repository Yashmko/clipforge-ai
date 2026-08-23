import { describe, expect, it } from "vitest";

describe("Gemini deployment configuration", () => {
  it("makes a non-empty Gemini key available to server-side code", () => {
    expect(typeof process.env.GEMINI_API_KEY).toBe("string");
    expect(process.env.GEMINI_API_KEY?.trim().length).toBeGreaterThan(0);
  });
});
