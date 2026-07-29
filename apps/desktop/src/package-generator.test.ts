import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UnifiedComment } from "@xhs/shared";
import { generateAnalysisPackage } from "./package-generator.js";

describe("analysis package generator", () => {
  it("preserves threads, clusters duplicate expressions, and checksums batches", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "xhs-package-"));
    const comments = [
      makeComment("C_000001", "p1", "相同表达", "same", 1),
      makeComment("C_000002", "r1", "楼中楼回复", "reply", 2, "p1"),
      makeComment("C_000003", "p2", "相同表达", "same", 1)
    ];
    await writeFile(
      path.join(taskDir, "comments.jsonl"),
      `${comments.map((comment) => JSON.stringify(comment)).join("\n")}\n`,
      "utf8"
    );
    const summary = await generateAnalysisPackage({
      taskDir,
      taskId: "task-test",
      target: {
        normalized_url: "https://www.xiaohongshu.com/explore/abc123",
        note_id: "abc123",
        note_type: "image_text",
        title: "测试",
        body: null,
        source_domain: "www.xiaohongshu.com"
      },
      maxBatchCharacters: 8
    });
    expect(summary).toEqual({
      batchCount: 2,
      threadCount: 2,
      duplicateClusterCount: 1,
      commentCount: 3
    });

    const threads = (await readFile(path.join(taskDir, "threads.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(threads[0].member_comment_ids).toEqual(["C_000001", "C_000002"]);

    const duplicateClusters = JSON.parse(
      await readFile(path.join(taskDir, "duplicate_clusters.json"), "utf8")
    );
    expect(duplicateClusters.clusters[0].member_comment_ids).toEqual([
      "C_000001",
      "C_000003"
    ]);

    const batchIndex = JSON.parse(
      await readFile(path.join(taskDir, "batch-index.json"), "utf8")
    );
    expect(batchIndex.batches).toHaveLength(2);
    expect(batchIndex.batches.every((batch: { sha256: string }) => batch.sha256.length === 64)).toBe(true);
    const firstBatch = await readFile(
      path.join(taskDir, "batches", batchIndex.batches[0].file),
      "utf8"
    );
    expect(firstBatch).toContain('"local_comment_id":"C_000001"');
    expect(firstBatch).toContain('"local_comment_id":"C_000002"');
    expect(firstBatch).not.toContain('"local_comment_id":"C_000003"');
    const firstGptBatch = JSON.parse(
      await readFile(
        path.join(taskDir, "batches", batchIndex.batches[0].gpt_file),
        "utf8"
      )
    );
    expect(firstGptBatch.task_type).toBe("xhs_comment_batch_classification");
    expect(firstGptBatch.comments).toHaveLength(2);
    const gptUpload = JSON.parse(
      await readFile(path.join(taskDir, "gpt_upload.json"), "utf8")
    );
    expect(gptUpload.task_id).toBe("task-test");
    expect(gptUpload.comments).toHaveLength(3);
    expect(gptUpload.comments[0].comment_id).toBe("C_000001");
    expect(gptUpload.output_schema.analysis.main_viewpoints[0].member_comment_ids).toEqual([
      "C_000001"
    ]);
    expect(gptUpload.output_schema.analysis.claims_to_verify[0]).toMatchObject({
      claim_type: "product_or_service_effect",
      verification_status: "unverified"
    });
    expect(gptUpload.instructions.analysis.join("\n")).toContain(
      "other_verifiable_claim"
    );
  });
});

function makeComment(
  localId: string,
  platformId: string,
  content: string,
  fingerprint: string,
  level: 1 | 2,
  parentId: string | null = null
): UnifiedComment {
  return {
    local_comment_id: localId,
    platform_comment_id: platformId,
    note_id: "abc123",
    parent_comment_id: parentId,
    root_comment_id: parentId,
    comment_level: level,
    content,
    created_at_raw: "1天前",
    created_at_normalized: "2026-07-25T00:00:00.000Z",
    created_at_precision: "day",
    ip_location_raw: null,
    ip_location_normalized: null,
    like_count: 1,
    reply_count: level === 1 ? 1 : 0,
    sort_source: "current",
    sample_group: "current_fallback",
    author_local_id: `A_${localId}`,
    is_note_author: false,
    is_pinned: false,
    comment_status: "active",
    read_source: "dom",
    captured_at: "2026-07-26T00:00:00.000Z",
    thread_depth: level === 1 ? 0 : 1,
    manual_expand: false,
    identity_source: "platform_id",
    content_fingerprint: fingerprint,
    duplicate_status: "unique",
    first_seen_at: "2026-07-26T00:00:00.000Z",
    last_seen_at: "2026-07-26T00:00:00.000Z"
  };
}
