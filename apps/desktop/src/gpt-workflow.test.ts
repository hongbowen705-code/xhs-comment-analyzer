import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UnifiedComment } from "@xhs/shared";
import {
  generateSemanticAnalysisUpload,
  importGptRepairResult,
  importGptResult,
  importSemanticAnalysisResult,
  validateSemanticAnalysis
} from "./gpt-workflow.js";
import {
  applyManualRevision,
  getReviewState,
  rebuildReviewQueue
} from "./review-service.js";

function comment(
  id: string,
  content: string,
  level: 1 | 2 = 1,
  parentId: string | null = null
): UnifiedComment {
  return {
    local_comment_id: id,
    platform_comment_id: id,
    note_id: "note",
    parent_comment_id: parentId,
    root_comment_id: parentId ?? id,
    comment_level: level,
    content,
    created_at_raw: "1天前",
    created_at_normalized: null,
    created_at_precision: "day",
    ip_location_raw: null,
    ip_location_normalized: null,
    like_count: id.endsWith("1") ? 10 : 2,
    reply_count: 0,
    sort_source: "current",
    sample_group: "current_fallback",
    author_local_id: null,
    is_note_author: false,
    is_pinned: false,
    comment_status: "active",
    read_source: "dom",
    captured_at: "2026-07-29T00:00:00.000Z",
    thread_depth: level === 1 ? 0 : 1,
    manual_expand: false,
    identity_source: "platform_id",
    content_fingerprint: id,
    duplicate_status: "unique",
    first_seen_at: "2026-07-29T00:00:00.000Z",
    last_seen_at: "2026-07-29T00:00:00.000Z"
  };
}

function classification(id: string, stance: string) {
  return {
    schema_version: "1.0",
    comment_id: id,
    primary_category: "有效分析",
    secondary_tags: ["测试"],
    stance,
    category_confidence: 0.9,
    stance_confidence: 0.9,
    relevance: 80,
    reasoning_quality: 70,
    information_density: 70,
    evidence_strength: 60,
    discussion_contribution: 60,
    clarity: 80,
    factual_content_type: "value_judgment",
    sarcasm: "unlikely",
    aggression_present: false,
    aggression_type: [] as string[],
    aggression_target: null,
    context_quality: "sufficient",
    context_comment_ids: [id],
    needs_review: false,
    review_reasons: [] as string[],
    brief_reason: "测试分类"
  };
}

function analysis() {
  return {
    executive_summary: "评论主要围绕方案是否有效展开。",
    sentiment_summary: "既有支持，也有反对和条件性意见。",
    main_viewpoints: [{
      viewpoint_id: "V_001",
      title: "认可方案",
      summary: "部分评论认可方案价值。",
      member_comment_ids: ["C_000001"],
      representative_comment_ids: ["C_000001"]
    }],
    controversies: [{
      controversy_id: "X_001",
      title: "效果争议",
      summary: "评论对实际效果存在分歧。",
      evidence_comment_ids: ["C_000001", "C_000002"]
    }],
    high_value_comments: [{ comment_id: "C_000001", reason: "给出了清晰理由" }],
    consensus_statements: [{
      statement: "需要结合具体场景判断",
      evidence_comment_ids: ["C_000001"]
    }],
    claims_to_verify: [{
      claim: "某项效果数据需要外部核验",
      claim_type: "product_or_service_effect",
      verification_status: "unverified",
      evidence_comment_ids: ["C_000002"]
    }],
    limitations: ["仅分析本次采样评论"]
  };
}

describe("single-file GPT workflow", () => {
  it("rejects invented evidence ids", () => {
    const invalid = analysis();
    invalid.main_viewpoints[0]!.member_comment_ids = ["C_999999"];
    expect(validateSemanticAnalysis(invalid, ["C_000001"]).issues).toContain(
      "main_viewpoints[0].member_comment_ids 含不存在的评论 ID：C_999999"
    );
  });

  it("imports a complete GPT JSON and generates local stats and HTML summary", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "xhs-gpt-flow-"));
    const comments = [
      comment("C_000001", "支持这个方案"),
      comment("C_000002", "效果存疑", 2, "C_000001")
    ];
    const secondClassification = classification("C_000002", "质疑");
    secondClassification.category_confidence = 0.6;
    secondClassification.needs_review = true;
    secondClassification.review_reasons = ["category_low_confidence"];
    await writeFile(
      path.join(taskDir, "comments.jsonl"),
      `${comments.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(taskDir, "note.json"),
      JSON.stringify({ schema_version: "1.0", task_id: "task-e2e", note: {} }),
      "utf8"
    );
    const resultPath = path.join(taskDir, "gpt_result.json");
    await writeFile(
      resultPath,
      JSON.stringify({
        schema_version: "1.0",
        task_id: "task-e2e",
        classifications: [
          classification("C_000001", "支持"),
          secondClassification
        ],
        analysis: analysis()
      }),
      "utf8"
    );
    const result = await importGptResult(taskDir, resultPath);
    expect(result.status).toBe("accepted");
    expect(result.report_path).toBe(path.join(taskDir, "report_private", "index.html"));
    const report = await readFile(result.report_path!, "utf8");
    expect(report).toContain("评论主要围绕方案是否有效展开");
    expect(report).toContain("50.0%");
    expect(report).toContain("公开IP属地");
    expect(report).toContain("产品或服务效果");
    expect(report).toContain("软件未联网判断真假");
    expect(report).toContain("conic-gradient");
    expect(report).toContain("类别 × 态度热力图");
    expect(report).toContain('class="comment-audit"');
    expect(report).toContain("评论明细（审计用）");
    expect(report).toContain('data-insight-group="viewpoints"');
    expect(report).toContain('data-collapse-action="open"');
    expect(report).toContain("全部收起");
    expect(await readFile(path.join(taskDir, "ai_results", "analysis_result.json"), "utf8"))
      .toContain("效果争议");
    const shareReport = await readFile(path.join(taskDir, "report_share.html"), "utf8");
    expect(shareReport).toContain("代表性证据评论");
    expect(shareReport).not.toContain("公开IP属地");
    expect(await readFile(path.join(taskDir, "privacy-scan.json"), "utf8"))
      .toContain('"status": "passed"');
    const viewpointStats = JSON.parse(
      await readFile(path.join(taskDir, "ai_results", "viewpoint-stats.json"), "utf8")
    );
    expect(viewpointStats.viewpoints[0]).toMatchObject({
      viewpoint_id: "V_001",
      root_comment_count: 1,
      reply_comment_count: 0,
      stance_counts: { 支持: 1 },
      controversy_ids: ["X_001"]
    });
    const reportData = JSON.parse(
      await readFile(path.join(taskDir, "report_private", "report-data.json"), "utf8")
    );
    expect(reportData.claim_type_counts).toEqual({
      product_or_service_effect: 1
    });
    const semanticUpload = await generateSemanticAnalysisUpload(taskDir);
    expect(await readFile(semanticUpload, "utf8")).toContain(
      '"task_type": "xhs_comment_semantic_analysis"'
    );
    const semanticOnlyPath = path.join(taskDir, "semantic-only.json");
    await writeFile(
      semanticOnlyPath,
      JSON.stringify({
        schema_version: "1.0",
        task_id: "task-e2e",
        analysis: analysis()
      }),
      "utf8"
    );
    expect((await importSemanticAnalysisResult(taskDir, semanticOnlyPath)).status).toBe(
      "accepted"
    );
    const reviewState = await getReviewState(taskDir);
    expect(reviewState.pending_count).toBe(1);
    expect(reviewState.current?.comment_id).toBe("C_000002");
    expect(reviewState.current?.context_complete).toBe(true);
    expect(reviewState.current?.thread_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          comment_id: "C_000001",
          is_parent: true,
          is_root: true
        })
      ])
    );
    const afterReview = await applyManualRevision(taskDir, {
      comment_id: "C_000002",
      primary_category: "事实补充",
      stance: "部分支持或有条件支持",
      secondary_tags: ["人工修订"],
      reason: "结合上下文重新判断"
    });
    expect(afterReview.pending_count).toBe(0);
    expect(
      await readFile(path.join(taskDir, "ai_results", "manual-revisions.jsonl"), "utf8")
    ).toContain("结合上下文重新判断");
    expect(
      await readFile(path.join(taskDir, "ai_results", "classification-merged.jsonl"), "utf8")
    ).toContain("部分支持或有条件支持");
  });

  it("rejects unsupported claim types and truth verdicts", () => {
    const invalid = analysis();
    invalid.claims_to_verify[0]!.claim_type = "medical_fact";
    invalid.claims_to_verify[0]!.verification_status = "verified";
    const result = validateSemanticAnalysis(invalid, ["C_000001", "C_000002"]);
    expect(result.analysis).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("claim_type 不在固定枚举中"),
        expect.stringContaining("verification_status 只能是 unverified")
      ])
    );
  });

  it("keeps V0.6 semantic results compatible and marks old claims unverified", () => {
    const legacy = analysis() as Record<string, any>;
    delete legacy.claims_to_verify[0].claim_type;
    delete legacy.claims_to_verify[0].verification_status;
    const result = validateSemanticAnalysis(legacy, ["C_000001", "C_000002"]);
    expect(result.issues).toEqual([]);
    expect(result.analysis?.claims_to_verify[0]).toMatchObject({
      claim_type: "other_verifiable_claim",
      verification_status: "unverified"
    });
  });

  it("rebuilds an existing queue while preserving completed reviews and a backup", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "xhs-review-policy-"));
    const resultDir = path.join(taskDir, "ai_results");
    await mkdir(resultDir, { recursive: true });
    const comments = [
      comment("C_000001", "已复核"),
      comment("C_000002", "仅由AI主动标记")
    ];
    const records = [
      classification("C_000001", "支持"),
      classification("C_000002", "支持")
    ];
    await writeFile(
      path.join(taskDir, "comments.jsonl"),
      `${comments.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(resultDir, "classification-merged.jsonl"),
      `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(resultDir, "review-queue.json"),
      JSON.stringify({
        schema_version: "1.0",
        generated_at: "2026-07-29T00:00:00.000Z",
        status: "pending_manual_review",
        count: 1,
        items: [
          {
            comment_id: "C_000001",
            priority_score: 1,
            review_reasons: ["category_low_confidence"],
            interaction_score: 1,
            like_count: 10,
            reply_count: 0,
            comment_level: 1,
            original_ai_result: records[0],
            review_status: "reviewed",
            revision_id: "REV_existing",
            reviewed_at: "2026-07-29T01:00:00.000Z"
          },
          {
            comment_id: "C_000002",
            priority_score: 1,
            review_reasons: ["ai_uncertain"],
            interaction_score: 1,
            like_count: 2,
            reply_count: 0,
            comment_level: 1,
            original_ai_result: records[1],
            review_status: "pending"
          }
        ]
      }),
      "utf8"
    );
    const rebuilt = await rebuildReviewQueue(taskDir);
    expect(rebuilt.previous_pending_count).toBe(1);
    expect(rebuilt.new_pending_count).toBe(0);
    expect(rebuilt.state.reviewed_count).toBe(1);
    expect(rebuilt.state.total_count).toBe(1);
    expect(await readFile(rebuilt.backup_path, "utf8")).toContain("C_000002");
  });

  it("generates and merges a partial repair request instead of redoing all comments", async () => {
    const taskDir = await mkdtemp(path.join(tmpdir(), "xhs-gpt-repair-"));
    const comments = [
      comment("C_000001", "支持这个方案"),
      comment("C_000002", "效果存疑", 2, "C_000001")
    ];
    await writeFile(
      path.join(taskDir, "comments.jsonl"),
      `${comments.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8"
    );
    await writeFile(
      path.join(taskDir, "note.json"),
      JSON.stringify({ schema_version: "1.0", task_id: "task-repair", note: {} }),
      "utf8"
    );
    const incompletePath = path.join(taskDir, "incomplete.json");
    await writeFile(
      incompletePath,
      JSON.stringify({
        schema_version: "1.0",
        task_id: "task-repair",
        classifications: [classification("C_000001", "支持")],
        analysis: analysis()
      }),
      "utf8"
    );
    const incomplete = await importGptResult(taskDir, incompletePath);
    expect(incomplete.status).toBe("rejected");
    expect(incomplete.repair_request_path).toBe(path.join(taskDir, "gpt_repair_request.json"));
    const request = JSON.parse(
      await readFile(incomplete.repair_request_path!, "utf8")
    );
    expect(request.failed_comment_ids).toEqual(["C_000002"]);
    expect(request.comments).toHaveLength(1);

    const repairPath = path.join(taskDir, "repair-result.json");
    await writeFile(
      repairPath,
      JSON.stringify({
        schema_version: "1.0",
        task_id: "task-repair",
        classifications: [classification("C_000002", "质疑")]
      }),
      "utf8"
    );
    const repaired = await importGptRepairResult(taskDir, repairPath);
    expect(repaired.status).toBe("accepted");
    expect(repaired.accepted_comment_count).toBe(2);
    expect(repaired.repair_request_path).toBeNull();
  });
});
