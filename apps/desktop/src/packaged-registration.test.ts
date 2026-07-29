import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@xhs/shared";
import { buildNativeHostManifest } from "./packaged-registration.js";

describe("packaged native host registration", () => {
  it("builds a fixed-origin stdio manifest with an absolute host path", () => {
    const manifest = buildNativeHostManifest(
      path.join("C:\\", "Program Files", "XHS", "host.exe")
    );
    expect(manifest).toMatchObject({
      name: NATIVE_HOST_NAME,
      type: "stdio",
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    });
    expect(path.isAbsolute(manifest.path)).toBe(true);
  });
});
