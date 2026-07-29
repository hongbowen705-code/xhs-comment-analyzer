import { describe, expect, it } from "vitest";
import { createEnvelope, MAX_NATIVE_MESSAGE_BYTES } from "@xhs/shared";
import { encodeNativeMessage, NativeMessageDecoder } from "./framing.js";

describe("Native Messaging framing", () => {
  it("decodes fragmented and adjacent frames", () => {
    const one = encodeNativeMessage(createEnvelope("capability_check", { n: 1 }));
    const two = encodeNativeMessage(createEnvelope("capability_check", { n: 2 }));
    const decoder = new NativeMessageDecoder();
    expect(decoder.push(one.subarray(0, 3))).toHaveLength(0);
    const decoded = decoder.push(Buffer.concat([one.subarray(3), two]));
    expect(decoded).toHaveLength(2);
  });

  it("rejects oversized output", () => {
    expect(() => encodeNativeMessage({ value: "x".repeat(MAX_NATIVE_MESSAGE_BYTES) })).toThrow();
  });
});
