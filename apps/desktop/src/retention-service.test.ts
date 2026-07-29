import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applySafeCleanup, createCleanupPlan } from "./retention-service.js";

describe("retention service", () => {
  it("removes only cache/log candidates and never raw comments or reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xhs-retention-"));
    await mkdir(path.join(root, "cache"), { recursive: true });
    await mkdir(path.join(root, "task_old", "report_private"), { recursive: true });
    const cachePath = path.join(root, "cache", "temporary.bin");
    const commentsPath = path.join(root, "task_old", "comments.jsonl");
    await writeFile(cachePath, "cache");
    await writeFile(commentsPath, "{\"comment\":\"protected\"}\n");
    await writeFile(path.join(root, "task_old", "report_private", "index.html"), "report");

    const plan = await createCleanupPlan(root, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(plan.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "cache", safe_to_auto_remove: true }),
        expect.objectContaining({ kind: "raw_retention_review", safe_to_auto_remove: false })
      ])
    );
    const result = await applySafeCleanup(plan);
    expect(result.removed_count).toBe(1);
    expect(await readFile(commentsPath, "utf8")).toContain("protected");
    expect(await readFile(path.join(root, "task_old", "report_private", "index.html"), "utf8")).toBe("report");

    await writeFile(
      path.join(root, "task_old", "manifest.json"),
      JSON.stringify({ retention: { permanent_raw: true } })
    );
    const protectedPlan = await createCleanupPlan(
      root,
      new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    );
    expect(
      protectedPlan.candidates.filter(
        (item) => item.kind === "raw_retention_review"
      )
    ).toHaveLength(0);
  });
});
