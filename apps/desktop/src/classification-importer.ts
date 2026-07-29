import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UnifiedComment } from "@xhs/shared";

export const PRIMARY_CATEGORIES = [
  "有效分析",
  "个人经历或案例",
  "事实补充",
  "提问或求证",
  "情绪表达",
  "攻击、嘲讽或标签化表达",
  "无关内容、广告或灌水",
  "无法判断"
] as const;

export const STANCES = [
  "支持",
  "反对",
  "部分支持或有条件支持",
  "中立补充",
  "质疑",
  "态度不明确"
] as const;

const FACTUAL_CONTENT_TYPES = [
  "none",
  "verifiable_claim",
  "personal_experience",
  "speculation_or_hearsay",
  "value_judgment",
  "unclear"
] as const;

type PrimaryCategory = (typeof PRIMARY_CATEGORIES)[number];
type Stance = (typeof STANCES)[number];
type FactualContentType = (typeof FACTUAL_CONTENT_TYPES)[number];

export interface ClassificationRecord {
  schema_version: "1.0";
  comment_id: string;
  primary_category: PrimaryCategory;
  secondary_tags: string[];
  stance: Stance;
  category_confidence: number;
  stance_confidence: number;
  relevance: number;
  reasoning_quality: number;
  information_density: number;
  evidence_strength: number;
  discussion_contribution: number;
  clarity: number;
  factual_content_type: FactualContentType;
  sarcasm: "unlikely" | "possible" | "likely";
  aggression_present: boolean;
  aggression_type: string[];
  aggression_target: string | null;
  context_quality: "sufficient" | "insufficient";
  context_comment_ids: string[];
  needs_review: boolean;
  review_reasons: string[];
  brief_reason: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  source_file: string;
  line: number;
  comment_id?: string;
}

export interface ClassificationValidation {
  validRecords: ClassificationRecord[];
  issues: ValidationIssue[];
  missingCommentIds: string[];
  duplicateCommentIds: string[];
  coverage: {
    expected: number;
    accepted: number;
    ratio: number;
  };
}

export interface ClassificationImportSummary {
  imported_at: string;
  source_files: string[];
  status: "accepted" | "rejected";
  expected_comment_count: number;
  accepted_comment_count: number;
  missing_comment_ids: string[];
  duplicate_comment_ids: string[];
  issue_count: number;
  merged_checksum: string | null;
  stats_file: string | null;
  review_file: string | null;
  review_count: number;
}

export interface ReviewQueueItem {
  comment_id: string;
  priority_score: number;
  review_reasons: string[];
  interaction_score: number;
  like_count: number;
  reply_count: number;
  comment_level: 1 | 2 | 3 | null;
  original_ai_result: ClassificationRecord;
  review_status: "pending";
}

export interface ConsistencyReviewItem {
  cluster_key: string;
  comment_ids: string[];
  primary_categories: string[];
  stances: string[];
  reason: "same_expression_different_classification";
}

interface DistributionRow {
  value: string;
  count: number;
  ratio: number;
  like_weight: number;
  like_weight_ratio: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown, maxItems = 30): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length <= 100)
  );
}

function isScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizeContextQuality(
  value: unknown
): ClassificationRecord["context_quality"] | null {
  if (value === "sufficient" || value === "insufficient") return value;
  if (
    typeof value === "string" &&
    /^(limited|partial|low|insufficient_context|有限|不足)$/i.test(value.trim())
  ) {
    return "insufficient";
  }
  if (
    typeof value === "string" &&
    /^(adequate|complete|enough|充分|完整)$/i.test(value.trim())
  ) {
    return "sufficient";
  }
  return null;
}

function issue(
  issues: ValidationIssue[],
  sourceFile: string,
  line: number,
  code: string,
  message: string,
  commentId?: string,
  severity: "error" | "warning" = "error"
): void {
  issues.push({
    severity,
    code,
    message,
    source_file: sourceFile,
    line,
    ...(commentId ? { comment_id: commentId } : {})
  });
}

function validateRecord(
  value: unknown,
  sourceFile: string,
  line: number,
  knownIds: Set<string>,
  issues: ValidationIssue[]
): ClassificationRecord | null {
  if (!isObject(value)) {
    issue(issues, sourceFile, line, "record_not_object", "每行必须是 JSON 对象。");
    return null;
  }

  const commentId = typeof value.comment_id === "string" ? value.comment_id : undefined;
  const beforeErrors = issues.filter((item) => item.severity === "error").length;
  const normalizedContextQuality = normalizeContextQuality(value.context_quality);

  if (value.schema_version !== "1.0") {
    issue(issues, sourceFile, line, "schema_version_invalid", "schema_version 必须为 1.0。", commentId);
  }
  if (!commentId || !knownIds.has(commentId)) {
    issue(issues, sourceFile, line, "comment_id_unknown", "comment_id 不存在于本次采集。", commentId);
  }
  if (!PRIMARY_CATEGORIES.includes(value.primary_category as PrimaryCategory)) {
    issue(issues, sourceFile, line, "primary_category_invalid", "主要类别不在固定枚举中。", commentId);
  }
  if (!STANCES.includes(value.stance as Stance)) {
    issue(issues, sourceFile, line, "stance_invalid", "态度不在固定枚举中。", commentId);
  }
  if (!isStringArray(value.secondary_tags, 20)) {
    issue(issues, sourceFile, line, "secondary_tags_invalid", "secondary_tags 必须是最多 20 个短字符串。", commentId);
  }
  if (!isConfidence(value.category_confidence) || !isConfidence(value.stance_confidence)) {
    issue(issues, sourceFile, line, "confidence_invalid", "分类和态度置信度必须在 0—1 之间。", commentId);
  }

  const scoreFields = [
    "relevance",
    "reasoning_quality",
    "information_density",
    "evidence_strength",
    "discussion_contribution",
    "clarity"
  ] as const;
  for (const field of scoreFields) {
    if (!isScore(value[field])) {
      issue(issues, sourceFile, line, `${field}_invalid`, `${field} 必须在 0—100 之间。`, commentId);
    }
  }

  if (!FACTUAL_CONTENT_TYPES.includes(value.factual_content_type as FactualContentType)) {
    issue(issues, sourceFile, line, "factual_content_type_invalid", "事实内容类型不在固定枚举中。", commentId);
  }
  if (!["unlikely", "possible", "likely"].includes(value.sarcasm as string)) {
    issue(issues, sourceFile, line, "sarcasm_invalid", "sarcasm 不在固定枚举中。", commentId);
  }
  if (typeof value.aggression_present !== "boolean" || !isStringArray(value.aggression_type, 10)) {
    issue(issues, sourceFile, line, "aggression_invalid", "攻击性字段格式错误。", commentId);
  }
  if (value.aggression_target !== null && typeof value.aggression_target !== "string") {
    issue(issues, sourceFile, line, "aggression_target_invalid", "aggression_target 必须是字符串或 null。", commentId);
  }
  if (!normalizedContextQuality) {
    issue(issues, sourceFile, line, "context_quality_invalid", "context_quality 不在固定枚举中。", commentId);
  } else if (normalizedContextQuality !== value.context_quality) {
    issue(
      issues,
      sourceFile,
      line,
      "context_quality_normalized",
      `已将 context_quality=${String(value.context_quality)} 规范化为 ${normalizedContextQuality}。`,
      commentId,
      "warning"
    );
  }
  if (!isStringArray(value.context_comment_ids, 30)) {
    issue(issues, sourceFile, line, "context_ids_invalid", "context_comment_ids 格式错误。", commentId);
  } else {
    for (const contextId of value.context_comment_ids) {
      if (!knownIds.has(contextId)) {
        issue(issues, sourceFile, line, "context_id_unknown", `语境评论 ${contextId} 不存在。`, commentId);
      }
    }
  }
  if (
    typeof value.needs_review !== "boolean" ||
    !isStringArray(value.review_reasons, 20) ||
    typeof value.brief_reason !== "string" ||
    value.brief_reason.length > 500
  ) {
    issue(issues, sourceFile, line, "review_fields_invalid", "复核字段或简要理由格式错误。", commentId);
  }

  if (
    issues.filter((item) => item.severity === "error").length !== beforeErrors ||
    !commentId ||
    !normalizedContextQuality
  ) {
    return null;
  }

  return {
    schema_version: "1.0",
    comment_id: commentId,
    primary_category: value.primary_category as PrimaryCategory,
    secondary_tags: normalizeSecondaryTags(value.secondary_tags as string[]),
    stance: value.stance as Stance,
    category_confidence: value.category_confidence as number,
    stance_confidence: value.stance_confidence as number,
    relevance: value.relevance as number,
    reasoning_quality: value.reasoning_quality as number,
    information_density: value.information_density as number,
    evidence_strength: value.evidence_strength as number,
    discussion_contribution: value.discussion_contribution as number,
    clarity: value.clarity as number,
    factual_content_type: value.factual_content_type as FactualContentType,
    sarcasm: value.sarcasm as ClassificationRecord["sarcasm"],
    aggression_present: value.aggression_present as boolean,
    aggression_type: [...(value.aggression_type as string[])],
    aggression_target: value.aggression_target as string | null,
    context_quality: normalizedContextQuality,
    context_comment_ids: [...(value.context_comment_ids as string[])],
    needs_review: value.needs_review as boolean,
    review_reasons: [...(value.review_reasons as string[])],
    brief_reason: value.brief_reason as string
  };
}

const SECONDARY_TAG_ALIASES = new Map<string, string>([
  ["价格", "价格与性价比"],
  ["性价比", "价格与性价比"],
  ["价格性价比", "价格与性价比"],
  ["售后", "售后问题"],
  ["售后服务", "售后问题"],
  ["使用体验", "使用效果"],
  ["效果", "使用效果"],
  ["数据质疑", "数据来源质疑"],
  ["来源质疑", "数据来源质疑"],
  ["营销", "平台营销"],
  ["广告营销", "平台营销"]
]);

export function normalizeSecondaryTags(tags: string[]): string[] {
  const normalized = tags
    .map((tag) => tag.normalize("NFKC").replace(/\s+/g, "").trim())
    .filter(Boolean)
    .map((tag) => SECONDARY_TAG_ALIASES.get(tag) ?? tag.slice(0, 60));
  return [...new Set(normalized)].slice(0, 20);
}

export function validateClassificationSources(
  sources: Array<{ name: string; content: string }>,
  knownCommentIds: string[]
): ClassificationValidation {
  const knownIds = new Set(knownCommentIds);
  const validRecords: ClassificationRecord[] = [];
  const issues: ValidationIssue[] = [];
  const acceptedIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const source of sources) {
    const sourceRecords: Array<{ parsed: unknown; line: number }> = [];
    try {
      const whole = JSON.parse(source.content);
      if (
        whole &&
        typeof whole === "object" &&
        Array.isArray((whole as { classifications?: unknown }).classifications)
      ) {
        (whole as { classifications: unknown[] }).classifications.forEach(
          (parsed, index) => sourceRecords.push({ parsed, line: index + 1 })
        );
      } else if (!Array.isArray(whole)) {
        sourceRecords.push({ parsed: whole, line: 1 });
      } else {
        whole.forEach((parsed, index) =>
          sourceRecords.push({ parsed, line: index + 1 })
        );
      }
    } catch {
      const lines = source.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index]?.trim();
        if (!raw) continue;
        try {
          sourceRecords.push({ parsed: JSON.parse(raw), line: index + 1 });
        } catch {
          issue(issues, source.name, index + 1, "json_parse_error", "该行不是有效 JSON。");
        }
      }
    }
    for (const { parsed, line } of sourceRecords) {
      const record = validateRecord(parsed, source.name, line, knownIds, issues);
      if (!record) continue;
      if (acceptedIds.has(record.comment_id)) {
        duplicateIds.add(record.comment_id);
        issue(
          issues,
          source.name,
          line,
          "duplicate_comment_id",
          "同一 comment_id 出现多次。",
          record.comment_id
        );
        continue;
      }
      acceptedIds.add(record.comment_id);
      validRecords.push(record);
    }
  }

  const missingCommentIds = knownCommentIds.filter((id) => !acceptedIds.has(id));
  for (const commentId of missingCommentIds) {
    issue(issues, "(all)", 0, "comment_id_missing", "AI 结果缺少该评论。", commentId);
  }

  return {
    validRecords,
    issues,
    missingCommentIds,
    duplicateCommentIds: [...duplicateIds].sort(),
    coverage: {
      expected: knownCommentIds.length,
      accepted: validRecords.length,
      ratio: knownCommentIds.length === 0 ? 1 : validRecords.length / knownCommentIds.length
    }
  };
}

function distribution(
  values: string[],
  recordsById: Map<string, ClassificationRecord>,
  commentsById: Map<string, UnifiedComment>,
  getValue: (record: ClassificationRecord) => string
): DistributionRow[] {
  const total = recordsById.size;
  const totalWeight = [...recordsById.keys()].reduce(
    (sum, id) => sum + Math.log1p(Math.max(0, commentsById.get(id)?.like_count ?? 0)),
    0
  );
  return values.map((value) => {
    const ids = [...recordsById.entries()]
      .filter(([, record]) => getValue(record) === value)
      .map(([id]) => id);
    const likeWeight = ids.reduce(
      (sum, id) => sum + Math.log1p(Math.max(0, commentsById.get(id)?.like_count ?? 0)),
      0
    );
    return {
      value,
      count: ids.length,
      ratio: total === 0 ? 0 : ids.length / total,
      like_weight: likeWeight,
      like_weight_ratio: totalWeight === 0 ? 0 : likeWeight / totalWeight
    };
  });
}

export function calculateLocalClassificationStats(
  records: ClassificationRecord[],
  comments: UnifiedComment[]
): Record<string, unknown> {
  const commentsById = new Map(comments.map((comment) => [comment.local_comment_id, comment]));
  const recordsById = new Map(records.map((record) => [record.comment_id, record]));
  const informationValues = records.map((record) => ({
    comment_id: record.comment_id,
    information_value:
      record.relevance * 0.25 +
      record.reasoning_quality * 0.2 +
      record.information_density * 0.2 +
      record.evidence_strength * 0.15 +
      record.discussion_contribution * 0.15 +
      record.clarity * 0.05
  }));
  const rootRecords = records.filter(
    (record) => (commentsById.get(record.comment_id)?.comment_level ?? 1) === 1
  );
  const replyRecords = records.filter(
    (record) => (commentsById.get(record.comment_id)?.comment_level ?? 1) > 1
  );
  const secondaryTagCounts = countValues(
    records.flatMap((record) => record.secondary_tags)
  );
  const timeCounts = countValues(
    comments.map((comment) =>
      comment.created_at_normalized
        ? comment.created_at_normalized.slice(0, 7)
        : "时间未知"
    )
  );
  const rawIpCounts = countValues(
    comments.map((comment) => comment.ip_location_normalized ?? "属地未知")
  );
  const visibleIpCounts = new Map<string, number>();
  for (const [value, count] of rawIpCounts) {
    const safeValue =
      value === "属地未知" || count >= 3 ? value : "其他（小样本）";
    visibleIpCounts.set(
      safeValue,
      (visibleIpCounts.get(safeValue) ?? 0) + count
    );
  }

  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    calculation_owner: "local_program",
    classified_comment_count: records.length,
    root_comment_count: rootRecords.length,
    reply_comment_count: replyRecords.length,
    primary_category_distribution: distribution(
      [...PRIMARY_CATEGORIES],
      recordsById,
      commentsById,
      (record) => record.primary_category
    ),
    secondary_tag_distribution: countDistribution(
      secondaryTagCounts,
      Math.max(1, records.length)
    ),
    category_stance_cross_table: buildCrossTable(records),
    stance_distribution: distribution(
      [...STANCES],
      recordsById,
      commentsById,
      (record) => record.stance
    ),
    root_stance_distribution: distribution(
      [...STANCES],
      new Map(rootRecords.map((record) => [record.comment_id, record])),
      commentsById,
      (record) => record.stance
    ),
    reply_stance_distribution: distribution(
      [...STANCES],
      new Map(replyRecords.map((record) => [record.comment_id, record])),
      commentsById,
      (record) => record.stance
    ),
    time_distribution: countDistribution(timeCounts, comments.length),
    ip_location_distribution: countDistribution(
      visibleIpCounts,
      comments.length
    ),
    ip_small_sample_threshold: 3,
    information_value_formula_version: "1.0",
    information_values: informationValues
  };
}

function buildCrossTable(
  records: ClassificationRecord[]
): Array<{
  primary_category: string;
  stance: string;
  count: number;
  ratio_of_all: number;
}> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = `${record.primary_category}\u0000${record.stance}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [primaryCategory, stance] = key.split("\u0000");
      return {
        primary_category: primaryCategory!,
        stance: stance!,
        count,
        ratio_of_all: records.length ? count / records.length : 0
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.primary_category.localeCompare(right.primary_category, "zh-CN")
    );
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function countDistribution(
  counts: Map<string, number>,
  total: number
): Array<{ value: string; count: number; ratio: number }> {
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      count,
      ratio: total === 0 ? 0 : count / total
    }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value, "zh-CN"));
}

export function buildReviewQueue(
  records: ClassificationRecord[],
  comments: UnifiedComment[]
): ReviewQueueItem[] {
  const commentsById = new Map(comments.map((comment) => [comment.local_comment_id, comment]));
  const interactions = comments
    .map(
      (comment) =>
        Math.log1p(Math.max(0, comment.like_count ?? 0)) +
        Math.log1p(Math.max(0, comment.reply_count ?? 0))
    )
    .sort((left, right) => left - right);
  const highInteractionThreshold =
    interactions.length === 0 ? Number.POSITIVE_INFINITY : interactions[Math.floor(interactions.length * 0.8)] ?? 0;
  const inconsistentIds = new Set(
    buildConsistencyReview(records, comments).flatMap((item) => item.comment_ids)
  );

  const queue: ReviewQueueItem[] = [];
  for (const record of records) {
      const comment = commentsById.get(record.comment_id);
      const interaction =
        Math.log1p(Math.max(0, comment?.like_count ?? 0)) +
        Math.log1p(Math.max(0, comment?.reply_count ?? 0));
      const reasons = new Set(record.review_reasons);
      if (record.category_confidence < 0.72) reasons.add("category_low_confidence");
      if (record.stance_confidence < 0.78) reasons.add("stance_low_confidence");
      if (record.context_quality === "insufficient") reasons.add("context_insufficient");
      if (record.sarcasm !== "unlikely") reasons.add("sarcasm_present");
      if (record.aggression_present && !record.aggression_target) reasons.add("aggression_target_unclear");
      const highInteraction = interaction >= highInteractionThreshold && interactions.length >= 5;
      if (
        highInteraction &&
        (record.category_confidence < 0.8 || record.stance_confidence < 0.82)
      ) {
        reasons.add("high_interaction_low_confidence");
      }
      if (inconsistentIds.has(record.comment_id)) {
        reasons.add("similar_comment_inconsistent");
      }
      if (!record.needs_review && reasons.size === 0) continue;
      const confidenceRisk =
        (1 - record.category_confidence) * 100 + (1 - record.stance_confidence) * 100;
      const priorityScore =
        (highInteraction ? 300 : 0) +
        (record.context_quality === "insufficient" ? 120 : 0) +
        (record.sarcasm !== "unlikely" ? 80 : 0) +
        interaction * 10 +
        confidenceRisk;
      queue.push({
        comment_id: record.comment_id,
        priority_score: Math.round(priorityScore * 100) / 100,
        review_reasons: [...reasons].sort(),
        interaction_score: Math.round(interaction * 100) / 100,
        like_count: comment?.like_count ?? 0,
        reply_count: comment?.reply_count ?? 0,
        comment_level: comment?.comment_level ?? null,
        original_ai_result: record,
        review_status: "pending"
      });
  }
  return queue.sort((left, right) => right.priority_score - left.priority_score);
}

export function buildConsistencyReview(
  records: ClassificationRecord[],
  comments: UnifiedComment[]
): ConsistencyReviewItem[] {
  const recordById = new Map(records.map((record) => [record.comment_id, record]));
  const clusters = new Map<string, string[]>();
  for (const comment of comments) {
    if (!recordById.has(comment.local_comment_id)) continue;
    const key = comment.content_fingerprint;
    const ids = clusters.get(key) ?? [];
    ids.push(comment.local_comment_id);
    clusters.set(key, ids);
  }
  const output: ConsistencyReviewItem[] = [];
  for (const [clusterKey, ids] of clusters) {
    if (ids.length < 2) continue;
    const primaryCategories = [
      ...new Set(ids.map((id) => recordById.get(id)!.primary_category))
    ];
    const stances = [...new Set(ids.map((id) => recordById.get(id)!.stance))];
    if (primaryCategories.length < 2 && stances.length < 2) continue;
    output.push({
      cluster_key: clusterKey,
      comment_ids: ids,
      primary_categories: primaryCategories,
      stances,
      reason: "same_expression_different_classification"
    });
  }
  return output.sort(
    (left, right) =>
      right.comment_ids.length - left.comment_ids.length ||
      left.cluster_key.localeCompare(right.cluster_key)
  );
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function importClassificationFiles(
  taskDir: string,
  sourceFiles: string[]
): Promise<ClassificationImportSummary> {
  const commentsPath = path.join(taskDir, "comments.jsonl");
  const comments = await readJsonl<UnifiedComment>(commentsPath);
  const sources = await Promise.all(
    sourceFiles.map(async (sourceFile) => ({
      name: path.basename(sourceFile),
      content: await readFile(sourceFile, "utf8")
    }))
  );
  const validation = validateClassificationSources(
    sources,
    comments.map((comment) => comment.local_comment_id)
  );
  const aiResultsDir = path.join(taskDir, "ai_results");
  await mkdir(aiResultsDir, { recursive: true });

  const validationFile = path.join(aiResultsDir, "classification-validation.json");
  await writeFile(
    validationFile,
    JSON.stringify(
      {
        schema_version: "1.0",
        validated_at: new Date().toISOString(),
        source_files: sourceFiles.map((file) => path.basename(file)),
        coverage: validation.coverage,
        missing_comment_ids: validation.missingCommentIds,
        duplicate_comment_ids: validation.duplicateCommentIds,
        issues: validation.issues
      },
      null,
      2
    ),
    "utf8"
  );

  const rejected = validation.issues.some((item) => item.severity === "error");
  let mergedChecksum: string | null = null;
  let statsFile: string | null = null;
  let reviewFile: string | null = null;
  let reviewCount = 0;
  if (!rejected) {
    const merged = `${validation.validRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    mergedChecksum = sha256(merged);
    await writeFile(path.join(aiResultsDir, "classification-merged.jsonl"), merged, "utf8");
    const stats = calculateLocalClassificationStats(validation.validRecords, comments);
    statsFile = "analysis-stats.json";
    await writeFile(path.join(aiResultsDir, statsFile), JSON.stringify(stats, null, 2), "utf8");
    const reviewQueue = buildReviewQueue(validation.validRecords, comments);
    const consistencyReview = buildConsistencyReview(
      validation.validRecords,
      comments
    );
    await writeFile(
      path.join(aiResultsDir, "consistency-review.jsonl"),
      consistencyReview.length
        ? `${consistencyReview.map((item) => JSON.stringify(item)).join("\n")}\n`
        : "",
      "utf8"
    );
    reviewFile = "review-queue.json";
    reviewCount = reviewQueue.length;
    await writeFile(
      path.join(aiResultsDir, reviewFile),
      JSON.stringify(
        {
          schema_version: "1.0",
          generated_at: new Date().toISOString(),
          status: "pending_manual_review",
          count: reviewQueue.length,
          items: reviewQueue
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(aiResultsDir, "classification-index.json"),
      JSON.stringify(
        {
          schema_version: "1.0",
          imported_at: new Date().toISOString(),
          record_count: validation.validRecords.length,
          checksum: mergedChecksum,
          source_files: sourceFiles.map((file) => path.basename(file))
        },
        null,
        2
      ),
      "utf8"
    );
  }

  return {
    imported_at: new Date().toISOString(),
    source_files: sourceFiles.map((file) => path.basename(file)),
    status: rejected ? "rejected" : "accepted",
    expected_comment_count: validation.coverage.expected,
    accepted_comment_count: validation.coverage.accepted,
    missing_comment_ids: validation.missingCommentIds,
    duplicate_comment_ids: validation.duplicateCommentIds,
    issue_count: validation.issues.length,
    merged_checksum: mergedChecksum,
    stats_file: statsFile,
    review_file: reviewFile,
    review_count: reviewCount
  };
}
