import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommentBatchPayload, WireComment } from "@xhs/shared";
import { TaskStore, sanitizeLogText, sha256 } from "./task-store.js";

const target = {
  normalized_url: "https://www.xiaohongshu.com/explore/abc",
  note_id: "abc",
  note_type: "video" as const,
  title: "测试",
  body: null,
  source_domain: "www.xiaohongshu.com"
};

describe("TaskStore", () => {
  it("accepts a batch idempotently and emits complete schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xhs-store-"));
    const store = new TaskStore(root);
    const view = await store.createTask(target);
    const comment: WireComment = {
      platform_comment_id: "p1",
      parent_comment_id: null,
      root_comment_id: null,
      content: "  有价值的评论 ",
      created_at_raw: "3天前",
      ip_location_raw: "IP属地：上海",
      like_count: 3,
      reply_count: 0,
      is_note_author: false,
      is_pinned: false,
      comment_level: 1,
      thread_depth: 0,
      capture_comment_key: "platform:p1",
      parent_capture_key: null,
      root_capture_key: null,
      manual_expand: false,
      identity_hint: "hashed-user",
      read_source: "dom",
      sort_source: "hot",
      sample_group: "hot_layer",
      captured_at: "2026-07-26T12:00:00.000Z"
    };
    const payload: CommentBatchPayload = {
      batch_no: 1,
      count: 1,
      checksum: sha256(JSON.stringify([comment])),
      retry: false,
      comments: [comment]
    };
    expect(await store.acceptBatch(payload)).toEqual({ accepted: 1, duplicate: 0 });
    expect(await store.acceptBatch(payload)).toEqual({ accepted: 0, duplicate: 1 });
    const line = await readFile(path.join(view.taskDir, "comments.jsonl"), "utf8");
    const saved = JSON.parse(line.trim());
    expect(saved.local_comment_id).toBe("C_000001");
    expect(saved.ip_location_normalized).toBe("上海");
    expect(saved.created_at_precision).toBe("day");
    expect(saved.sort_source).toBe("hot");
    await store.finish(
      { reason: "limit_reached", captured_count: 1 },
      false
    );
    expect(store.getView()?.samplingCounts.hot).toBe(1);
    const sampling = JSON.parse(
      await readFile(path.join(view.taskDir, "sampling.json"), "utf8")
    );
    expect(sampling.platform_sort_claimed).toBe(false);
    expect(sampling.interaction_priority[0].comment_id).toBe("C_000001");
    const checkpoint = JSON.parse(
      await readFile(path.join(view.taskDir, "checkpoint.json"), "utf8")
    );
    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.processed_batches).toHaveLength(1);
    expect(checkpoint.automatic_web_resume).toBe(false);
    await store.regenerateAnalysisPackage();
    const batchIndex = JSON.parse(
      await readFile(path.join(view.taskDir, "batch-index.json"), "utf8")
    );
    expect(batchIndex.batches[0].gpt_file).toBe("gpt_batch_001.json");
    await store.setPermanentRaw(true);
    expect(store.getView()?.permanentRaw).toBe(true);
    expect(store.getView()?.rawExpiresAt).toBeNull();
    const retainedManifest = JSON.parse(
      await readFile(path.join(view.taskDir, "manifest.json"), "utf8")
    );
    expect(retainedManifest.retention).toMatchObject({
      permanent_raw: true,
      raw_expires_at: null,
      evidence_status: "complete",
      automatic_raw_deletion: false
    });
    await unlink(path.join(view.taskDir, "gpt_upload.json"));
    const reopened = await new TaskStore(root).openCompletedTask(view.taskDir);
    expect(reopened.taskId).toBe(view.taskId);
    expect(reopened.capturedCount).toBe(1);
    expect(
      JSON.parse(await readFile(path.join(view.taskDir, "gpt_upload.json"), "utf8")).comments
    ).toHaveLength(1);
  });

  it("redacts unsafe log hints", () => {
    expect(sanitizeLogText("cookie\nAuthorization nickname")).not.toMatch(/cookie|authorization|nickname/i);
  });

  it("persists all 100 quick-mode comments and creates a 100-comment GPT upload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xhs-store-100-"));
    const store = new TaskStore(root);
    const view = await store.createTask(target, 100, "quick");
    for (let batchNo = 1; batchNo <= 5; batchNo += 1) {
      const comments: WireComment[] = Array.from({ length: 20 }, (_, offset) => {
        const number = (batchNo - 1) * 20 + offset + 1;
        return {
          platform_comment_id: `platform_${number}`,
          parent_comment_id: null,
          root_comment_id: null,
          content: `第 ${number} 条评论`,
          created_at_raw: `${number}分钟前`,
          ip_location_raw: null,
          like_count: number,
          reply_count: 0,
          is_note_author: false,
          is_pinned: false,
          comment_level: 1,
          thread_depth: 0,
          capture_comment_key: `platform:platform_${number}`,
          parent_capture_key: null,
          root_capture_key: null,
          manual_expand: false,
          identity_hint: `author_${number}`,
          read_source: "dom",
          sort_source: "current",
          sample_group: "current_fallback",
          captured_at: "2026-07-29T00:00:00.000Z"
        };
      });
      await store.acceptBatch({
        batch_no: batchNo,
        count: comments.length,
        checksum: sha256(JSON.stringify(comments)),
        retry: false,
        comments
      });
    }
    await store.finish({ reason: "limit_reached", captured_count: 100 }, false);
    expect(store.getView()?.capturedCount).toBe(100);
    expect(store.getView()?.captureLimit).toBe(100);
    const manifest = JSON.parse(
      await readFile(path.join(view.taskDir, "manifest.json"), "utf8")
    );
    expect(manifest.capture).toMatchObject({
      mode: "quick",
      requested_limit: 100,
      captured_count: 100,
      stop_reason: "limit_reached"
    });
    const upload = JSON.parse(
      await readFile(path.join(view.taskDir, "gpt_upload.json"), "utf8")
    );
    expect(upload.comments).toHaveLength(100);
    expect(upload.comments.at(-1).comment_id).toBe("C_000100");
    const history = await store.listTasks();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      taskId: view.taskId,
      capturedCount: 100,
      captureLimit: 100,
      analysisReady: false
    });
  });

  it("prepares a paused task for user-initiated resume without losing existing data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xhs-store-resume-"));
    const store = new TaskStore(root);
    const view = await store.createTask(target, 100, "quick");
    const comment: WireComment = {
      platform_comment_id: "resume_platform_1",
      parent_comment_id: null,
      root_comment_id: null,
      content: "恢复前已经读取的评论",
      created_at_raw: "3分钟前",
      ip_location_raw: null,
      like_count: 1,
      reply_count: 0,
      is_note_author: false,
      is_pinned: false,
      comment_level: 1,
      thread_depth: 0,
      capture_comment_key: "platform:resume_platform_1",
      parent_capture_key: null,
      root_capture_key: null,
      manual_expand: false,
      identity_hint: "resume_author",
      read_source: "dom",
      sort_source: "current",
      sample_group: "current_fallback",
      captured_at: "2026-07-29T00:00:00.000Z"
    };
    await store.acceptBatch({
      batch_no: 1,
      count: 1,
      checksum: sha256(JSON.stringify([comment])),
      retry: false,
      comments: [comment]
    });
    await store.finish({ reason: "tab_closed", captured_count: 1 }, true);

    const resume = await store.prepareResume();
    expect(resume).toMatchObject({
      taskId: view.taskId,
      captureLimit: 100,
      initialCount: 1,
      existingPlatformIds: ["resume_platform_1"]
    });
    expect(resume.existingContentKeys).toHaveLength(1);
    expect(resume.captureToken).toBeTruthy();
    expect(store.getView()?.phase).toBe("capturing");
    expect(store.getView()?.capturedCount).toBe(1);
  });
});
