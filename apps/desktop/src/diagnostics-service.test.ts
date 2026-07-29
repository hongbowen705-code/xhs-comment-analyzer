import { describe, expect, it } from "vitest";
import { EXTENSION_ID } from "@xhs/shared";
import { analyzeDiagnosticSnapshot } from "./diagnostics-service.js";

describe("connection diagnostics", () => {
  it("identifies another registered build without exposing sensitive data", () => {
    const result = analyzeDiagnosticSnapshot({
      chromeFound: true,
      manifestPath: "C:\\App\\manifest.json",
      manifest: {
        path: process.execPath,
        allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
      },
      expectedHostPath: "C:\\Different\\host.exe"
    });
    expect(result.status).toBe("warning");
    expect(result.issue_codes).toContain("different_version_registered");
    expect(JSON.stringify(result)).not.toMatch(/cookie|password|comment_content/i);
  });
});
