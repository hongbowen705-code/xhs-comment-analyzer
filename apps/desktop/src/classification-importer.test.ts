import { describe, expect, it } from "vitest";
import type { UnifiedComment } from "@xhs/shared";
import {
  buildReviewQueue,
  buildConsistencyReview,
  calculateLocalClassificationStats,
  normalizeSecondaryTags,
  validateClassificationSources
} from "./classification-importer.js";

function record(commentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "1.0",
    comment_id: commentId,
    primary_category: "有效分析",
    secondary_tags: ["价格"],
    stance: "支持",
    category_confidence: 0.9,
    stance_confidence: 0.8,
    relevance: 80,
    reasoning_quality: 70,
    information_density: 60,
    evidence_strength: 50,
    discussion_contribution: 40,
    clarity: 90,
    factual_content_type: "verifiable_claim",
    sarcasm: "unlikely",
    aggression_present: false,
    aggression_type: [],
    aggression_target: null,
    context_quality: "sufficient",
    context_comment_ids: [commentId],
    needs_review: false,
    review_reasons: [],
    brief_reason: "测试",
    ...overrides
  };
}

function comment(id: string, level: 1 | 2, likes: number): UnifiedComment {
  return {
    local_comment_id: id,
    platform_comment_id: null,
    note_id: "note",
    parent_comment_id: level === 1 ? null : "C_000001",
    root_comment_id: level === 1 ? id : "C_000001",
    comment_level: level,
    content: "内容",
    created_at_raw: null,
    created_at_normalized: null,
    created_at_precision: "unknown",
    ip_location_raw: null,
    ip_location_normalized: null,
    like_count: likes,
    reply_count: 0,
    sort_source: "current",
    sample_group: "current_fallback",
    author_local_id: null,
    is_note_author: false,
    is_pinned: false,
    comment_status: "active",
    read_source: "dom",
    captured_at: "2026-01-01T00:00:00.000Z",
    thread_depth: level - 1 as 0 | 1,
    manual_expand: false,
    identity_source: "display_hash",
    content_fingerprint: id,
    duplicate_status: "unique",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-01T00:00:00.000Z"
  };
}

describe("classification importer", () => {
  it("accepts complete fixed-schema results", () => {
    const result = validateClassificationSources(
      [{ name: "batch.jsonl", content: `${JSON.stringify(record("C_000001"))}\n` }],
      ["C_000001"]
    );
    expect(result.issues).toHaveLength(0);
    expect(result.coverage.ratio).toBe(1);
  });

  it("rejects unknown ids, invalid enums, duplicates and omissions", () => {
    const source = [
      JSON.stringify(record("C_000001")),
      JSON.stringify(record("C_000001")),
      JSON.stringify(record("C_999999", { primary_category: "AI自创类别" }))
    ].join("\n");
    const result = validateClassificationSources([{ name: "bad.jsonl", content: source }], [
      "C_000001",
      "C_000002"
    ]);
    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["duplicate_comment_id", "comment_id_unknown", "primary_category_invalid", "comment_id_missing"])
    );
  });

  it("calculates deterministic local distributions and information value", () => {
    const records = [
      record("C_000001"),
      record("C_000002", { stance: "反对", primary_category: "事实补充" })
    ] as never[];
    const stats = calculateLocalClassificationStats(records, [
      comment("C_000001", 1, 9),
      comment("C_000002", 2, 0)
    ]);
    expect(stats.calculation_owner).toBe("local_program");
    expect(stats.root_comment_count).toBe(1);
    expect(stats.reply_comment_count).toBe(1);
    expect(stats.information_values).toEqual([
      { comment_id: "C_000001", information_value: 64 },
      { comment_id: "C_000002", information_value: 64 }
    ]);
    expect(stats.time_distribution).toEqual([
      { value: "时间未知", count: 2, ratio: 1 }
    ]);
    expect(stats.ip_location_distribution).toEqual([
      { value: "属地未知", count: 2, ratio: 1 }
    ]);
    expect(stats.category_stance_cross_table).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          primary_category: "有效分析",
          stance: "支持",
          count: 1
        }),
        expect.objectContaining({
          primary_category: "事实补充",
          stance: "反对",
          count: 1
        })
      ])
    );
  });

  it("merges common synonymous secondary tags deterministically", () => {
    expect(
      normalizeSecondaryTags(["价格", " 性价比 ", "售后服务", "售后", "自定义"])
    ).toEqual(["价格与性价比", "售后问题", "自定义"]);
  });

  it("safely normalizes GPT's limited context label without rejecting the comment", () => {
    const result = validateClassificationSources(
      [{
        name: "gpt.jsonl",
        content: JSON.stringify(record("C_000001", { context_quality: "limited" }))
      }],
      ["C_000001"]
    );
    expect(result.validRecords[0]?.context_quality).toBe("insufficient");
    expect(result.issues).toContainEqual(
      expect.objectContaining({ severity: "warning", code: "context_quality_normalized" })
    );
    expect(result.coverage.ratio).toBe(1);
  });

  it("accepts a GPT batch JSON wrapper as well as JSONL", () => {
    const result = validateClassificationSources(
      [{
        name: "batch.json",
        content: JSON.stringify({
          schema_version: "1.0",
          task_id: "task",
          batch_no: 1,
          classifications: [record("C_000001")]
        })
      }],
      ["C_000001"]
    );
    expect(result.validRecords).toHaveLength(1);
    expect(result.issues.filter((item) => item.severity === "error")).toHaveLength(0);
  });

  it("flags identical expressions that received inconsistent classifications", () => {
    const first = comment("C_000001", 1, 1);
    const second = comment("C_000002", 1, 1);
    first.content_fingerprint = "same-expression";
    second.content_fingerprint = "same-expression";
    const records = [
      record("C_000001"),
      record("C_000002", { stance: "反对" })
    ] as never[];
    expect(buildConsistencyReview(records, [first, second])).toEqual([
      expect.objectContaining({
        comment_ids: ["C_000001", "C_000002"],
        stances: ["支持", "反对"]
      })
    ]);
    expect(buildReviewQueue(records, [first, second])).toHaveLength(2);
  });

  it("prioritizes low-confidence and context-poor comments for manual review", () => {
    const records = [
      record("C_000001", {
        category_confidence: 0.6,
        stance_confidence: 0.7,
        context_quality: "insufficient",
        needs_review: false
      })
    ] as never[];
    const queue = buildReviewQueue(records, [comment("C_000001", 1, 20)]);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.review_reasons).toEqual(
      expect.arrayContaining([
        "category_low_confidence",
        "stance_low_confidence",
        "context_insufficient"
      ])
    );
    expect(queue[0]?.original_ai_result).toBeDefined();
  });
});
