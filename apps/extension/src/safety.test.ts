import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(import.meta.dirname);

describe("extension safety boundary", () => {
  it("keeps permissions on the explicit read-only allowlist", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(sourceRoot, "manifest.json"), "utf8")
    ) as { permissions: string[]; host_permissions: string[] };
    expect(manifest.permissions.sort()).toEqual(
      ["activeTab", "nativeMessaging", "scripting", "storage", "tabs"].sort()
    );
    expect(manifest.host_permissions.sort()).toEqual(
      [
        "https://www.xiaohongshu.com/*",
        "https://xiaohongshu.com/*"
      ].sort()
    );
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("debugger");
    expect(manifest.permissions).not.toContain("webRequest");
  });

  it("contains no privileged write or dynamic-code APIs", async () => {
    const files = ["background.ts", "content.ts", "observer.ts"];
    const source = (
      await Promise.all(files.map((file) => readFile(path.join(sourceRoot, file), "utf8")))
    ).join("\n");
    for (const forbidden of [
      "chrome.cookies",
      "chrome.debugger",
      "chrome.webRequest",
      "dangerouslySetInnerHTML",
      "eval("
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("duplicates the readable tab instead of reopening a stripped XHS URL", async () => {
    const background = await readFile(path.join(sourceRoot, "background.ts"), "utf8");
    expect(background).toContain("chrome.tabs.duplicate(tab.id)");
    expect(background).not.toContain("chrome.tabs.create({ url: detected.target.normalized_url");
  });

  it("only recovers missing receivers with packaged scripts on an allowed note tab", async () => {
    const background = await readFile(path.join(sourceRoot, "background.ts"), "utf8");
    expect(background).toContain("if (!tab.url || !isAllowedXhsUrl(tab.url))");
    expect(background).toContain('files: ["observer.js"]');
    expect(background).toContain('files: ["content.js"]');
    expect(background).toContain('world: "MAIN"');
    expect(background).toContain('world: "ISOLATED"');
    expect(background).not.toContain("func:");
  });

  it("does not claim or click nonexistent platform comment sorting", async () => {
    const content = await readFile(path.join(sourceRoot, "content.ts"), "utf8");
    expect(content).not.toContain("switch_sort_hot");
    expect(content).not.toContain("switch_sort_latest");
    expect(content).not.toContain("findCommentSortControl");
    expect(content).toContain('sampling_strategy: "current_order_then_local_proxy"');
  });
});
