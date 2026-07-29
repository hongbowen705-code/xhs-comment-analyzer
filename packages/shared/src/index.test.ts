import { describe, expect, it } from "vitest";
import {
  captureModeForLimit,
  createEnvelope,
  isAllowedXhsUrl,
  isEnvelope,
  normalizeCaptureLimit,
  normalizeXhsUrl,
  parseRelativeTime
} from "./index.js";

describe("shared protocol", () => {
  it("keeps 100 and 500 capture limits across persisted and wire values", () => {
    expect(normalizeCaptureLimit(100)).toBe(100);
    expect(normalizeCaptureLimit("100")).toBe(100);
    expect(normalizeCaptureLimit(500)).toBe(500);
    expect(normalizeCaptureLimit(3000)).toBe(3000);
    expect(normalizeCaptureLimit("invalid")).toBe(50);
    expect(captureModeForLimit(100)).toBe("quick");
    expect(captureModeForLimit(2000)).toBe("deep");
  });

  it("validates envelopes and rejects unknown message types", () => {
    expect(isEnvelope(createEnvelope("capability_check", {}))).toBe(true);
    expect(
      isEnvelope({
        ...createEnvelope("capability_check", {}),
        message_type: "like_note"
      })
    ).toBe(false);
  });

  it("only permits supported note URLs", () => {
    expect(isAllowedXhsUrl("https://www.xiaohongshu.com/explore/abc123")).toBe(true);
    expect(isAllowedXhsUrl("https://evil.example/explore/abc123")).toBe(false);
  });

  it("removes query parameters that may contain access tokens", () => {
    const normalized = normalizeXhsUrl(
      "https://www.xiaohongshu.com/explore/abc?utm_source=x&xsec_token=secret#comments"
    );
    expect(normalized).toBe("https://www.xiaohongshu.com/explore/abc");
    expect(normalized).not.toContain("secret");
  });

  it("does not invent precision for relative dates", () => {
    const captured = new Date("2026-07-26T12:30:00.000Z");
    const parsed = parseRelativeTime("3天前", captured);
    expect(parsed.precision).toBe("day");
    expect(parsed.normalized).toContain("2026-07-23");
    expect(parseRelativeTime("不明确", captured)).toEqual({
      normalized: null,
      precision: "unknown"
    });
  });
});
