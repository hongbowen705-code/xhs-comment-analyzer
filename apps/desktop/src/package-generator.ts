import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NoteTarget, UnifiedComment } from "@xhs/shared";
import { CLAIM_TYPES } from "./claim-types.js";

export interface GeneratedPackageSummary {
  batchCount: number;
  threadCount: number;
  duplicateClusterCount: number;
  commentCount: number;
}

interface ThreadRecord {
  thread_id: string;
  root_comment_id: string;
  member_comment_ids: string[];
  reply_count: number;
  character_count: number;
  comments: UnifiedComment[];
}

export async function generateAnalysisPackage(input: {
  taskDir: string;
  taskId: string;
  target: NoteTarget;
  maxBatchCharacters?: number;
}): Promise<GeneratedPackageSummary> {
  const comments = await readComments(path.join(input.taskDir, "comments.jsonl"));
  const threads = buildThreads(comments);
  const duplicateClusters = buildDuplicateClusters(comments);
  const batches = buildBatches(threads, input.maxBatchCharacters ?? 60_000);
  const gptUpload = createGptUploadTask(input.taskId, input.target, comments);
  const batchesDir = path.join(input.taskDir, "batches");
  const resultsDir = path.join(input.taskDir, "ai_results");
  await Promise.all([
    mkdir(batchesDir, { recursive: true }),
    mkdir(resultsDir, { recursive: true })
  ]);

  await writeJson(path.join(input.taskDir, "note.json"), {
    schema_version: "1.0",
    task_id: input.taskId,
    note: input.target
  });
  await writeJsonLines(
    path.join(input.taskDir, "threads.jsonl"),
    threads.map(({ comments: _comments, ...thread }) => thread)
  );
  await writeJson(path.join(input.taskDir, "duplicate_clusters.json"), {
    schema_version: "1.0",
    strategy: "normalized_content_fingerprint",
    cluster_count: duplicateClusters.length,
    clusters: duplicateClusters
  });

  const batchIndex: Array<{
    batch_no: number;
    file: string;
    gpt_file: string;
    comment_count: number;
    character_count: number;
    comment_id_first: string | null;
    comment_id_last: string | null;
    sha256: string;
  }> = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    const file = `batch_${String(index + 1).padStart(3, "0")}.jsonl`;
    const gptFile = `gpt_batch_${String(index + 1).padStart(3, "0")}.json`;
    const body = batch.comments.length
      ? `${batch.comments.map((comment) => JSON.stringify(comment)).join("\n")}\n`
      : "";
    await writeFile(path.join(batchesDir, file), body, "utf8");
    await writeJson(path.join(batchesDir, gptFile), {
      schema_version: "1.0",
      task_type: "xhs_comment_batch_classification",
      task_id: input.taskId,
      batch_no: index + 1,
      batch_count: batches.length,
      instructions: [
        "只分类本文件 comments 中的评论。",
        "只返回严格 JSON 对象，不使用 Markdown 代码块。",
        "classifications 必须覆盖全部 comment_id，不能遗漏、重复或创造 ID。",
        "不要计算比例，不要在本批次生成总体观点总结。"
      ],
      note: input.target,
      comments: batch.comments,
      output_schema: {
        schema_version: "1.0",
        task_id: input.taskId,
        batch_no: index + 1,
        classifications: (
          gptUpload.output_schema as { classifications: unknown }
        ).classifications
      }
    });
    batchIndex.push({
      batch_no: index + 1,
      file,
      gpt_file: gptFile,
      comment_count: batch.comments.length,
      character_count: batch.characterCount,
      comment_id_first: batch.comments.at(0)?.local_comment_id ?? null,
      comment_id_last: batch.comments.at(-1)?.local_comment_id ?? null,
      sha256: sha256(body)
    });
  }

  await writeJson(path.join(input.taskDir, "batch-index.json"), {
    schema_version: "1.0",
    split_strategy: "character_count_preserve_threads",
    target_characters_per_batch: input.maxBatchCharacters ?? 60_000,
    total_comments: comments.length,
    total_threads: threads.length,
    batches: batchIndex
  });
  await writeFile(
    path.join(input.taskDir, "prompt.md"),
    createPrompt(input.taskId),
    "utf8"
  );
  await writeJson(
    path.join(input.taskDir, "gpt_upload.json"),
    gptUpload
  );
  await writeFile(
    path.join(input.taskDir, "README.txt"),
    createReadme(input.taskId, batchIndex.length),
    "utf8"
  );
  await writeFile(path.join(resultsDir, ".gitkeep"), "", "utf8");

  const summary: GeneratedPackageSummary = {
    batchCount: batchIndex.length,
    threadCount: threads.length,
    duplicateClusterCount: duplicateClusters.length,
    commentCount: comments.length
  };
  await writeJson(path.join(input.taskDir, "analysis-package.json"), {
    schema_version: "1.0",
    task_id: input.taskId,
    generated_at: new Date().toISOString(),
    files: {
      note: "note.json",
      comments: "comments.jsonl",
      threads: "threads.jsonl",
      sampling: "sampling.json",
      duplicate_clusters: "duplicate_clusters.json",
      batch_index: "batch-index.json",
      batches_directory: "batches",
      gpt_upload: "gpt_upload.json",
      prompt: "prompt.md",
      results_directory: "ai_results"
    },
    summary,
    safety: {
      external_ai_automation: false,
      cookie_exported: false,
      statistics_must_be_computed_locally: true
    }
  });
  return summary;
}

export function buildThreads(comments: UnifiedComment[]): ThreadRecord[] {
  const roots = comments.filter((comment) => comment.comment_level === 1);
  const rootByReference = new Map<string, UnifiedComment>();
  for (const root of roots) {
    rootByReference.set(root.local_comment_id, root);
    if (root.platform_comment_id) rootByReference.set(root.platform_comment_id, root);
  }
  const members = new Map<string, UnifiedComment[]>();
  for (const root of roots) members.set(root.local_comment_id, [root]);
  const orphans: UnifiedComment[] = [];
  for (const comment of comments) {
    if (comment.comment_level === 1) continue;
    const root =
      (comment.root_comment_id && rootByReference.get(comment.root_comment_id)) ||
      (comment.parent_comment_id && rootByReference.get(comment.parent_comment_id));
    if (!root) {
      orphans.push(comment);
      continue;
    }
    members.get(root.local_comment_id)!.push(comment);
  }
  for (const orphan of orphans) members.set(orphan.local_comment_id, [orphan]);
  return [...members.entries()].map(([rootId, threadComments], index) => ({
    thread_id: `T_${String(index + 1).padStart(6, "0")}`,
    root_comment_id: rootId,
    member_comment_ids: threadComments.map((comment) => comment.local_comment_id),
    reply_count: Math.max(0, threadComments.length - 1),
    character_count: threadComments.reduce(
      (total, comment) => total + comment.content.length,
      0
    ),
    comments: threadComments
  }));
}

export function buildDuplicateClusters(comments: UnifiedComment[]): Array<{
  cluster_id: string;
  content_fingerprint: string;
  member_comment_ids: string[];
  member_count: number;
}> {
  const groups = new Map<string, string[]>();
  for (const comment of comments) {
    const ids = groups.get(comment.content_fingerprint) ?? [];
    ids.push(comment.local_comment_id);
    groups.set(comment.content_fingerprint, ids);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprint, ids], index) => ({
      cluster_id: `D_${String(index + 1).padStart(6, "0")}`,
      content_fingerprint: fingerprint,
      member_comment_ids: ids,
      member_count: ids.length
    }));
}

function buildBatches(
  threads: ThreadRecord[],
  maxCharacters: number
): Array<{ comments: UnifiedComment[]; characterCount: number }> {
  const batches: Array<{ comments: UnifiedComment[]; characterCount: number }> = [];
  let current = { comments: [] as UnifiedComment[], characterCount: 0 };
  for (const thread of threads) {
    if (
      current.comments.length &&
      current.characterCount + thread.character_count > maxCharacters
    ) {
      batches.push(current);
      current = { comments: [], characterCount: 0 };
    }
    current.comments.push(...thread.comments);
    current.characterCount += thread.character_count;
  }
  if (current.comments.length || !batches.length) batches.push(current);
  return batches;
}

async function readComments(filePath: string): Promise<UnifiedComment[]> {
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UnifiedComment);
}

async function writeJsonLines(filePath: string, values: unknown[]): Promise<void> {
  const body = values.length
    ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n`
    : "";
  await writeFile(filePath, body, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createPrompt(taskId: string): string {
  return `# 小红书评论分析任务

任务 ID：${taskId}

请上传同目录中的 gpt_upload.json。完整阅读其中的 instructions、note、comments 和 output_schema。

请严格返回一个 JSON 对象，不要使用 Markdown 代码块，不要附加解释文字。返回对象必须符合 gpt_upload.json 中的 output_schema：
- classifications 必须覆盖每一个 comment_id，不能遗漏、重复或创造 ID。
- analysis 中所有证据 ID 必须来自 comments。
- AI 只做语义分类和文字总结，不计算比例，不生成 HTML。
- 高频说法不等于事实，个人经历与可核验声明必须区分。

将返回内容保存为 gpt_result.json，然后在桌面端点击“导入 GPT 结果 JSON”。
`;
}

function createReadme(taskId: string, batchCount: number): string {
  return `小红书评论分析任务 ${taskId}

1. 在网页版 ChatGPT 上传 gpt_upload.json。
2. 如有需要，同时复制 prompt.md 中的简短提示词。
3. 将 ChatGPT 返回的完整 JSON 保存为 gpt_result.json。
4. 在桌面端点击“导入 GPT 结果 JSON”并选择该文件。
5. 桌面端负责校验 ID、计算统计并生成 report_private/index.html。

当前批次数：${batchCount}
通常无需手动处理 batches；它们仅用于超长任务的分批补交和诊断。
提示：sampling.json 的“互动优先/时间优先”是本地代理分层，不是小红书平台排序。
`;
}

function createGptUploadTask(
  taskId: string,
  target: NoteTarget,
  comments: UnifiedComment[]
): Record<string, unknown> {
  return {
    schema_version: "1.0",
    task_type: "xhs_single_note_comment_analysis",
    task_id: taskId,
    instructions: {
      language: "zh-CN",
      output: "只返回一个严格 JSON 对象，不使用 Markdown 代码块或额外说明。",
      classification: {
        coverage: "classifications 必须逐条覆盖 comments 中全部 comment_id，不遗漏、不重复、不创造 ID。",
        primary_categories: [
          "有效分析",
          "个人经历或案例",
          "事实补充",
          "提问或求证",
          "情绪表达",
          "攻击、嘲讽或标签化表达",
          "无关内容、广告或灌水",
          "无法判断"
        ],
        stances: [
          "支持",
          "反对",
          "部分支持或有条件支持",
          "中立补充",
          "质疑",
          "态度不明确"
        ],
        factual_content_types: [
          "none",
          "verifiable_claim",
          "personal_experience",
          "speculation_or_hearsay",
          "value_judgment",
          "unclear"
        ],
        scoring: "六项语义评分为 0—100 整数；两个置信度为 0—1。",
        context_quality_values: ["sufficient", "insufficient"],
        context: "楼中楼结合父评论判断，context_comment_ids 只能引用本任务 ID。"
      },
      analysis: [
        "总结评论区主要态度，但不要计算百分比。",
        "形成主要观点簇、争议点、高价值评论和分析局限。",
        "每个观点和争议必须保存可追溯评论 ID。",
        "区分共识、争议、个人经历和待外部核验声明。",
        `每条待外部核验声明必须选择固定 claim_type：${CLAIM_TYPES.join(", ")}。`,
        "verification_status 必须固定为 unverified；不要联网，也不要判断声明真假。",
        "不得依据 IP 属地推断身份、职业、民族、籍贯或真实居住地。"
      ],
      deterministic_statistics: "不要计算数量比例或加权比例；桌面端将本地计算。"
    },
    note: target,
    comments: comments.map((comment) => ({
      comment_id: comment.local_comment_id,
      parent_comment_id: comment.parent_comment_id,
      root_comment_id: comment.root_comment_id,
      comment_level: comment.comment_level,
      content: comment.content,
      created_at: comment.created_at_raw,
      like_count: comment.like_count,
      reply_count: comment.reply_count,
      is_note_author: comment.is_note_author,
      is_pinned: comment.is_pinned
    })),
    output_schema: {
      schema_version: "1.0",
      task_id: taskId,
      classifications: [
        {
          schema_version: "1.0",
          comment_id: "C_000001",
          primary_category: "有效分析",
          secondary_tags: ["动态主题标签"],
          stance: "中立补充",
          category_confidence: 0.9,
          stance_confidence: 0.9,
          relevance: 80,
          reasoning_quality: 70,
          information_density: 70,
          evidence_strength: 50,
          discussion_contribution: 60,
          clarity: 80,
          factual_content_type: "verifiable_claim",
          sarcasm: "unlikely",
          aggression_present: false,
          aggression_type: [],
          aggression_target: null,
          context_quality: "sufficient",
          context_comment_ids: ["C_000001"],
          needs_review: false,
          review_reasons: [],
          brief_reason: "简短分类理由"
        }
      ],
      analysis: {
        executive_summary: "评论区总体总结",
        sentiment_summary: "主要态度及分歧的文字总结，不写百分比",
        main_viewpoints: [
          {
            viewpoint_id: "V_001",
            title: "观点标题",
            summary: "观点摘要",
            viewpoint_type: "主流观点",
            confidence: 0.85,
            member_comment_ids: ["C_000001"],
            representative_comment_ids: ["C_000001"]
          }
        ],
        controversies: [
          {
            controversy_id: "X_001",
            title: "争议标题",
            summary: "争议双方及论据摘要",
            evidence_comment_ids: ["C_000001"]
          }
        ],
        high_value_comments: [
          {
            comment_id: "C_000001",
            reason: "高价值原因"
          }
        ],
        consensus_statements: [
          {
            statement: "评论区共识说法",
            evidence_comment_ids: ["C_000001"]
          }
        ],
        claims_to_verify: [
          {
            claim: "待外部核验声明",
            claim_type: "product_or_service_effect",
            verification_status: "unverified",
            evidence_comment_ids: ["C_000001"]
          }
        ],
        limitations: ["采样与分析局限"]
      }
    }
  };
}
