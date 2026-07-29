import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStorageStatus } from "./storage-service.js";

describe("storage status", () => {
  it("counts task files without following external links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xhs-storage-"));
    await mkdir(path.join(root, "task_001"));
    await writeFile(path.join(root, "task_001", "comments.jsonl"), "12345", "utf8");
    const status = await getStorageStatus(root);
    expect(status.task_count).toBe(1);
    expect(status.used_bytes).toBe(5);
    expect(status.level).toBe("normal");
    expect(status.hard_limit_bytes).toBe(6 * 1024 ** 3);
  });
});
