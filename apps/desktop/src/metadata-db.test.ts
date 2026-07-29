import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listTaskMetadata, upsertTaskMetadata } from "./metadata-db.js";

describe("SQLite metadata", () => {
  it("creates and updates a task index without duplicating task ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xhs-sqlite-"));
    const base = {
      task_id: "task-1",
      task_dir: path.join(root, "task_task-1"),
      note_id: "note-1",
      title: "测试任务",
      phase: "capturing",
      capture_limit: 100,
      captured_count: 20,
      field_completeness: 60,
      stop_reason: null,
      updated_at: "2026-07-29T00:00:00.000Z"
    };
    await upsertTaskMetadata(root, base);
    await upsertTaskMetadata(root, {
      ...base,
      phase: "completed",
      captured_count: 100,
      updated_at: "2026-07-29T01:00:00.000Z"
    });
    const rows = await listTaskMetadata(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: "completed", captured_count: 100 });
  });
});
