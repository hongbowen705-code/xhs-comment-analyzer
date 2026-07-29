import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UnifiedComment } from "@xhs/shared";
import {
  PRIMARY_CATEGORIES,
  REVIEW_QUEUE_POLICY,
  STANCES,
  buildReviewQueue,
  buildConsistencyReview,
  calculateLocalClassificationStats,
  normalizeSecondaryTags,
  type ClassificationRecord,
  type ReviewQueueItem
} from "./classification-importer.js";
import {
  generatePrivateReport,
  type SemanticAnalysisResult
} from "./report-generator.js";

export interface ReviewItemView {
  comment_id: string;
  content: string;
  comment_level: number;
  like_count: number;
  reply_count: number;
  review_reasons: string[];
  primary_category: string;
  stance: string;
  secondary_tags: string[];
  category_confidence: number;
  stance_confidence: number;
  parent_comment_id: string | null;
  root_comment_id: string | null;
  context_complete: boolean;
  thread_context: Array<{
    comment_id: string;
    content: string;
    comment_level: number;
    like_count: number;
    reply_count: number;
    is_parent: boolean;
    is_root: boolean;
    is_current: boolean;
  }>;
}

export async function regenerateReport(taskDir: string): Promise<string> {
  const resultDir = path.join(taskDir, "ai_results");
  const comments = (await readFile(path.join(taskDir, "comments.jsonl"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UnifiedComment);
  const records = (
    await readFile(path.join(resultDir, "classification-merged.jsonl"), "utf8")
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ClassificationRecord);
  const stats = calculateLocalClassificationStats(records, comments);
  await writeFile(
    path.join(resultDir, "analysis-stats.json"),
    JSON.stringify(stats, null, 2),
    "utf8"
  );
  const consistencyReview = buildConsistencyReview(records, comments);
  await writeFile(
    path.join(resultDir, "consistency-review.jsonl"),
    consistencyReview.length
      ? `${consistencyReview.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "",
    "utf8"
  );
  const analysis = JSON.parse(
    await readFile(path.join(resultDir, "analysis_result.json"), "utf8")
  ) as SemanticAnalysisResult & { task_id: string };
  const report = await generatePrivateReport({
    taskDir,
    taskId: analysis.task_id,
    analysis
  });
  return report.reportPath;
}

export interface ReviewState {
  pending_count: number;
  reviewed_count: number;
  total_count: number;
  current: ReviewItemView | null;
  current_index: number;
  pending_items: Array<{
    comment_id: string;
    comment_level: number;
    excerpt: string;
    review_reasons: string[];
  }>;
}

export interface ManualRevisionInput {
  comment_id: string;
  primary_category: string;
  stance: string;
  secondary_tags?: string[];
  reason: string;
}

type StoredQueueItem = Omit<ReviewQueueItem, "review_status"> & {
  review_status: "pending" | "reviewed";
  revision_id?: string;
  reviewed_at?: string;
};

export interface ReviewQueueRebuildResult {
  previous_pending_count: number;
  new_pending_count: number;
  removed_pending_count: number;
  backup_path: string;
  state: ReviewState;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function readQueue(taskDir: string): Promise<{
  schema_version: string;
  generated_at: string;
  status: string;
  count: number;
  items: StoredQueueItem[];
}> {
  return JSON.parse(
    await readFile(path.join(taskDir, "ai_results", "review-queue.json"), "utf8")
  );
}

export async function rebuildReviewQueue(
  taskDir: string
): Promise<ReviewQueueRebuildResult> {
  const resultDir = path.join(taskDir, "ai_results");
  const queuePath = path.join(resultDir, "review-queue.json");
  const [queueText, comments, classifications] = await Promise.all([
    readFile(queuePath, "utf8"),
    readJsonl<UnifiedComment>(path.join(taskDir, "comments.jsonl")),
    readJsonl<ClassificationRecord>(
      path.join(resultDir, "classification-merged.jsonl")
    )
  ]);
  const oldQueue = JSON.parse(queueText) as {
    items: StoredQueueItem[];
  };
  const previousPending = oldQueue.items.filter(
    (item) => item.review_status !== "reviewed"
  ).length;
  const historyDir = path.join(resultDir, "review-queue-history");
  await mkdir(historyDir, { recursive: true });
  const backupPath = path.join(
    historyDir,
    `review-queue-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  await writeFile(backupPath, queueText, "utf8");

  const reviewedItems = oldQueue.items.filter(
    (item) => item.review_status === "reviewed"
  );
  const reviewedIds = new Set(reviewedItems.map((item) => item.comment_id));
  const pendingItems = buildReviewQueue(classifications, comments).filter(
    (item) => !reviewedIds.has(item.comment_id)
  );
  const items: StoredQueueItem[] = [...reviewedItems, ...pendingItems];
  const generatedAt = new Date().toISOString();
  await writeFile(
    queuePath,
    JSON.stringify(
      {
        schema_version: "2.0",
        generated_at: generatedAt,
        status:
          pendingItems.length === 0 ? "completed" : "pending_manual_review",
        count: pendingItems.length,
        policy: REVIEW_QUEUE_POLICY,
        previous_pending_count: previousPending,
        items
      },
      null,
      2
    ),
    "utf8"
  );
  return {
    previous_pending_count: previousPending,
    new_pending_count: pendingItems.length,
    removed_pending_count: Math.max(0, previousPending - pendingItems.length),
    backup_path: backupPath,
    state: await getReviewState(taskDir)
  };
}

export async function getReviewState(
  taskDir: string,
  requestedCommentId?: string
): Promise<ReviewState> {
  const [queue, comments, classifications] = await Promise.all([
    readQueue(taskDir),
    readJsonl<UnifiedComment>(path.join(taskDir, "comments.jsonl")),
    readJsonl<ClassificationRecord>(
      path.join(taskDir, "ai_results", "classification-merged.jsonl")
    )
  ]);
  const commentsById = new Map(comments.map((item) => [item.local_comment_id, item]));
  const classificationById = new Map(classifications.map((item) => [item.comment_id, item]));
  const pending = queue.items.filter((item) => item.review_status !== "reviewed");
  const requestedIndex = requestedCommentId
    ? pending.findIndex((item) => item.comment_id === requestedCommentId)
    : -1;
  const currentIndex = requestedIndex >= 0 ? requestedIndex : 0;
  const currentQueue = pending[currentIndex];
  const comment = currentQueue ? commentsById.get(currentQueue.comment_id) : null;
  const classification = currentQueue
    ? classificationById.get(currentQueue.comment_id)
    : null;
  const rootId = comment
    ? comment.comment_level === 1
      ? comment.local_comment_id
      : comment.root_comment_id ?? comment.parent_comment_id
    : null;
  const threadComments = comment
    ? comments
        .filter(
          (item) =>
            item.local_comment_id === rootId ||
            item.root_comment_id === rootId ||
            item.parent_comment_id === rootId
        )
        .sort(
          (left, right) =>
            left.comment_level - right.comment_level ||
            left.local_comment_id.localeCompare(right.local_comment_id)
        )
        .slice(0, 30)
    : [];
  const parentFound =
    !comment?.parent_comment_id ||
    commentsById.has(comment.parent_comment_id);
  const rootFound = !rootId || commentsById.has(rootId);
  return {
    pending_count: pending.length,
    reviewed_count: queue.items.length - pending.length,
    total_count: queue.items.length,
    current_index: currentQueue ? currentIndex : -1,
    pending_items: pending.flatMap((item) => {
      const pendingComment = commentsById.get(item.comment_id);
      return pendingComment
        ? [{
            comment_id: pendingComment.local_comment_id,
            comment_level: pendingComment.comment_level,
            excerpt: pendingComment.content.slice(0, 100),
            review_reasons: item.review_reasons
          }]
        : [];
    }),
    current:
      currentQueue && comment && classification
        ? {
            comment_id: comment.local_comment_id,
            content: comment.content,
            comment_level: comment.comment_level,
            like_count: comment.like_count ?? 0,
            reply_count: comment.reply_count ?? 0,
            review_reasons: currentQueue.review_reasons,
            primary_category: classification.primary_category,
            stance: classification.stance,
            secondary_tags: classification.secondary_tags,
            category_confidence: classification.category_confidence,
            stance_confidence: classification.stance_confidence,
            parent_comment_id: comment.parent_comment_id,
            root_comment_id: rootId,
            context_complete: parentFound && rootFound,
            thread_context: threadComments.map((item) => ({
              comment_id: item.local_comment_id,
              content: item.content,
              comment_level: item.comment_level,
              like_count: item.like_count ?? 0,
              reply_count: item.reply_count ?? 0,
              is_parent: item.local_comment_id === comment.parent_comment_id,
              is_root: item.local_comment_id === rootId,
              is_current: item.local_comment_id === comment.local_comment_id
            }))
          }
        : null
  };
}

export async function applyManualRevision(
  taskDir: string,
  input: ManualRevisionInput
): Promise<ReviewState> {
  if (!PRIMARY_CATEGORIES.includes(input.primary_category as never)) {
    throw new Error("人工修改的主要类别不在固定枚举中");
  }
  if (!STANCES.includes(input.stance as never)) {
    throw new Error("人工修改的态度不在固定枚举中");
  }
  if (!input.reason.trim() || input.reason.length > 500) {
    throw new Error("请填写不超过500字的修改原因");
  }
  const tags = input.secondary_tags ?? [];
  if (
    tags.length > 20 ||
    tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 100)
  ) {
    throw new Error("次要标签格式错误");
  }

  const resultDir = path.join(taskDir, "ai_results");
  const mergedPath = path.join(resultDir, "classification-merged.jsonl");
  const [records, comments, queue] = await Promise.all([
    readJsonl<ClassificationRecord>(mergedPath),
    readJsonl<UnifiedComment>(path.join(taskDir, "comments.jsonl")),
    readQueue(taskDir)
  ]);
  const index = records.findIndex((record) => record.comment_id === input.comment_id);
  if (index < 0) throw new Error("待修改评论不存在于分类结果");
  const queueItem = queue.items.find((item) => item.comment_id === input.comment_id);
  if (!queueItem) throw new Error("该评论不在待复核队列");
  const previous = records[index]!;
  const revised: ClassificationRecord = {
    ...previous,
    primary_category: input.primary_category as ClassificationRecord["primary_category"],
    stance: input.stance as ClassificationRecord["stance"],
    secondary_tags: normalizeSecondaryTags(tags),
    needs_review: false,
    review_reasons: []
  };
  const changedFields = (
    ["primary_category", "stance", "secondary_tags"] as const
  ).filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(revised[field]));
  const revisionId = `REV_${randomUUID()}`;
  const now = new Date().toISOString();
  await appendFile(
    path.join(resultDir, "manual-revisions.jsonl"),
    `${JSON.stringify({
      schema_version: "1.0",
      revision_id: revisionId,
      comment_id: input.comment_id,
      revised_at: now,
      changed_fields: changedFields,
      reason: input.reason.trim(),
      original_ai_result: queueItem.original_ai_result,
      previous_result: previous,
      revised_result: revised
    })}\n`,
    "utf8"
  );
  records[index] = revised;
  const merged = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await writeFile(mergedPath, merged, "utf8");
  queueItem.review_status = "reviewed";
  queueItem.revision_id = revisionId;
  queueItem.reviewed_at = now;
  queue.status = queue.items.every((item) => item.review_status === "reviewed")
    ? "completed"
    : "pending_manual_review";
  queue.count = queue.items.filter((item) => item.review_status !== "reviewed").length;
  await writeFile(
    path.join(resultDir, "review-queue.json"),
    JSON.stringify(queue, null, 2),
    "utf8"
  );

  const stats = calculateLocalClassificationStats(records, comments);
  await writeFile(
    path.join(resultDir, "analysis-stats.json"),
    JSON.stringify(stats, null, 2),
    "utf8"
  );
  const revisedConsistencyReview = buildConsistencyReview(records, comments);
  await writeFile(
    path.join(resultDir, "consistency-review.jsonl"),
    revisedConsistencyReview.length
      ? `${revisedConsistencyReview.map((item) => JSON.stringify(item)).join("\n")}\n`
      : "",
    "utf8"
  );
  await writeFile(
    path.join(resultDir, "classification-index.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        imported_at: now,
        record_count: records.length,
        checksum: createHash("sha256").update(merged).digest("hex"),
        source_files: ["classification-merged.jsonl"],
        manual_revision_count: await revisionCount(
          path.join(resultDir, "manual-revisions.jsonl")
        )
      },
      null,
      2
    ),
    "utf8"
  );
  const analysis = JSON.parse(
    await readFile(path.join(resultDir, "analysis_result.json"), "utf8")
  ) as SemanticAnalysisResult & { task_id: string };
  await generatePrivateReport({
    taskDir,
    taskId: analysis.task_id,
    analysis
  });
  return getReviewState(taskDir);
}

async function revisionCount(filePath: string): Promise<number> {
  return (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).length;
}
