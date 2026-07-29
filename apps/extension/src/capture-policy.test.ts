import { describe, expect, it } from "vitest";
import { maxCaptureCycles, noNewCycleThreshold } from "./capture-policy.js";

describe("capture policy", () => {
  it("does not retain the 50-comment cycle budget for quick and standard modes", () => {
    expect(maxCaptureCycles(50)).toBe(60);
    expect(maxCaptureCycles(100)).toBe(120);
    expect(maxCaptureCycles(500)).toBe(360);
    expect(maxCaptureCycles(1000)).toBe(720);
    expect(maxCaptureCycles(3000)).toBe(1800);
    expect(noNewCycleThreshold(100)).toBe(15);
  });
});
