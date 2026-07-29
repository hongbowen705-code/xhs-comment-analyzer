import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UnifiedComment } from "@xhs/shared";
import {
  importClassificationFiles,
  type ClassificationImportSummary
} from "./classification-importer.js";
import {
  generatePrivateReport,
  type SemanticAnalysisResult
} from "./report-generator.js";
import {
  CLAIM_TYPES,
  DEFAULT_CLAIM_TYPE,
  isClaimType
} from "./claim-types.js";

export interface GptImportSummary extends ClassificationImportSummary {
  analysis_status: "accepted" | "rejected";
  analysis_issues: string[];
  report_path: string | null;
  repair_request_path: string | null;
}

export interface SemanticImportSummary {
  status: "accepted" | "rejected";
  issue_count: number;
  issues: string[];
  report_path: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonResponse(raw: string): unknown {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  return JSON.parse(fenced ?? trimmed);
}

function text(value: unknown, maxLength = 20_000): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function stringArray(value: unknown, maxItems = 100): string[] | null {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length <= 500)
    ? value
    : null;
}

function validatedIds(
  value: unknown,
  knownIds: Set<string>,
  field: string,
  issues: string[],
  maxItems = 5_000
): string[] {
  const ids = stringArray(value, maxItems);
  if (!ids) {
    issues.push(`${field} 必须是字符串 ID 数组`);
    return [];
  }
  const unknown = ids.filter((id) => !knownIds.has(id));
  if (unknown.length) issues.push(`${field} 含不存在的评论 ID：${unknown.slice(0, 10).join(", ")}`);
  return ids.filter((id) => knownIds.has(id));
}

export function validateSemanticAnalysis(
  value: unknown,
  knownCommentIds: string[]
): { analysis: SemanticAnalysisResult | null; issues: string[] } {
  const issues: string[] = [];
  const knownIds = new Set(knownCommentIds);
  if (!isObject(value)) return { analysis: null, issues: ["analysis 必须是 JSON 对象"] };
  const executiveSummary = text(value.executive_summary);
  const sentimentSummary = text(value.sentiment_summary);
  if (!executiveSummary) issues.push("executive_summary 缺失或格式错误");
  if (!sentimentSummary) issues.push("sentiment_summary 缺失或格式错误");

  const viewpoints = Array.isArray(value.main_viewpoints)
    ? value.main_viewpoints.slice(0, 100).flatMap((raw, index) => {
        if (!isObject(raw)) {
          issues.push(`main_viewpoints[${index}] 格式错误`);
          return [];
        }
        const id = text(raw.viewpoint_id, 100);
        const title = text(raw.title, 500);
        const summary = text(raw.summary);
        const viewpointType = text(raw.viewpoint_type, 100);
        const confidence =
          typeof raw.confidence === "number" &&
          raw.confidence >= 0 &&
          raw.confidence <= 1
            ? raw.confidence
            : null;
        const members = validatedIds(
          raw.member_comment_ids,
          knownIds,
          `main_viewpoints[${index}].member_comment_ids`,
          issues
        );
        const representatives = validatedIds(
          raw.representative_comment_ids,
          knownIds,
          `main_viewpoints[${index}].representative_comment_ids`,
          issues
        );
        if (!id || !title || !summary || !members.length) {
          issues.push(`main_viewpoints[${index}] 缺少标题、摘要、ID或成员`);
          return [];
        }
        return [{
          viewpoint_id: id,
          title,
          summary,
          viewpoint_type: viewpointType,
          confidence,
          member_comment_ids: members,
          representative_comment_ids: representatives
        }];
      })
    : (issues.push("main_viewpoints 必须是数组"), []);

  const controversies = Array.isArray(value.controversies)
    ? value.controversies.slice(0, 100).flatMap((raw, index) => {
        if (!isObject(raw)) {
          issues.push(`controversies[${index}] 格式错误`);
          return [];
        }
        const id = text(raw.controversy_id, 100);
        const title = text(raw.title, 500);
        const summary = text(raw.summary);
        const evidence = validatedIds(
          raw.evidence_comment_ids,
          knownIds,
          `controversies[${index}].evidence_comment_ids`,
          issues
        );
        if (!id || !title || !summary || !evidence.length) {
          issues.push(`controversies[${index}] 缺少标题、摘要、ID或证据`);
          return [];
        }
        return [{ controversy_id: id, title, summary, evidence_comment_ids: evidence }];
      })
    : (issues.push("controversies 必须是数组"), []);

  const highValue = Array.isArray(value.high_value_comments)
    ? value.high_value_comments.slice(0, 100).flatMap((raw, index) => {
        if (!isObject(raw)) {
          issues.push(`high_value_comments[${index}] 格式错误`);
          return [];
        }
        const commentId = text(raw.comment_id, 100);
        const reason = text(raw.reason, 2_000);
        if (!commentId || !knownIds.has(commentId) || !reason) {
          issues.push(`high_value_comments[${index}] 评论 ID 不存在或理由缺失`);
          return [];
        }
        return [{ comment_id: commentId, reason }];
      })
    : (issues.push("high_value_comments 必须是数组"), []);

  const consensusStatements = Array.isArray(value.consensus_statements)
    ? value.consensus_statements.slice(0, 100).flatMap((raw, index) => {
        if (!isObject(raw)) {
          issues.push(`consensus_statements[${index}] 格式错误`);
          return [];
        }
        const statement = text(raw.statement);
        const evidence = validatedIds(
          raw.evidence_comment_ids,
          knownIds,
          `consensus_statements[${index}].evidence_comment_ids`,
          issues
        );
        if (!statement || !evidence.length) {
          issues.push(`consensus_statements[${index}] 内容或证据缺失`);
          return [];
        }
        return [{ statement, evidence_comment_ids: evidence }];
      })
    : (issues.push("consensus_statements 必须是数组"), []);

  const claimsToVerify = Array.isArray(value.claims_to_verify)
    ? value.claims_to_verify.slice(0, 100).flatMap((raw, index) => {
        if (!isObject(raw)) {
          issues.push(`claims_to_verify[${index}] 格式错误`);
          return [];
        }
        const claim = text(raw.claim);
        const claimType =
          raw.claim_type === undefined
            ? DEFAULT_CLAIM_TYPE
            : isClaimType(raw.claim_type)
              ? raw.claim_type
              : null;
        const verificationStatus: "unverified" | null =
          raw.verification_status === undefined
            ? "unverified"
            : raw.verification_status === "unverified"
              ? "unverified"
              : null;
        if (!claimType) {
          issues.push(
            `claims_to_verify[${index}].claim_type 不在固定枚举中：${CLAIM_TYPES.join(", ")}`
          );
        }
        if (!verificationStatus) {
          issues.push(
            `claims_to_verify[${index}].verification_status 只能是 unverified`
          );
        }
        const evidence = validatedIds(
          raw.evidence_comment_ids,
          knownIds,
          `claims_to_verify[${index}].evidence_comment_ids`,
          issues
        );
        if (!claim || !claimType || !verificationStatus || !evidence.length) {
          issues.push(`claims_to_verify[${index}] 内容、类型、状态或证据缺失`);
          return [];
        }
        return [{
          claim,
          claim_type: claimType,
          verification_status: verificationStatus,
          evidence_comment_ids: evidence
        }];
      })
    : (issues.push("claims_to_verify 必须是数组"), []);

  const limitations = stringArray(value.limitations, 100);
  if (!limitations) issues.push("limitations 必须是字符串数组");
  if (issues.length || !executiveSummary || !sentimentSummary) {
    return { analysis: null, issues };
  }
  return {
    issues,
    analysis: {
      executive_summary: executiveSummary,
      sentiment_summary: sentimentSummary,
      main_viewpoints: viewpoints,
      controversies,
      high_value_comments: highValue,
      consensus_statements: consensusStatements,
      claims_to_verify: claimsToVerify,
      limitations: limitations ?? []
    }
  };
}

export async function importGptResult(
  taskDir: string,
  sourceFile: string
): Promise<GptImportSummary> {
  const raw = await readFile(sourceFile, "utf8");
  const parsed = parseJsonResponse(raw);
  if (!isObject(parsed)) throw new Error("GPT 结果必须是 JSON 对象");
  const noteEnvelope = JSON.parse(await readFile(path.join(taskDir, "note.json"), "utf8")) as {
    task_id: string;
  };
  if (parsed.task_id !== noteEnvelope.task_id) {
    throw new Error(`任务 ID 不匹配：需要 ${noteEnvelope.task_id}`);
  }
  if (!Array.isArray(parsed.classifications)) {
    throw new Error("GPT 结果缺少 classifications 数组");
  }
  const commentsText = await readFile(path.join(taskDir, "comments.jsonl"), "utf8");
  const comments = commentsText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UnifiedComment);
  const semantic = validateSemanticAnalysis(
    parsed.analysis,
    comments.map((comment) => comment.local_comment_id)
  );
  const resultDir = path.join(taskDir, "ai_results");
  await mkdir(resultDir, { recursive: true });
  const classificationFile = path.join(resultDir, "classification-from-gpt.jsonl");
  await writeFile(
    classificationFile,
    `${parsed.classifications.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8"
  );
  const classification = await importClassificationFiles(taskDir, [classificationFile]);
  const accepted = classification.status === "accepted" && semantic.analysis !== null;
  await writeFile(
    path.join(resultDir, "gpt-import-validation.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        imported_at: new Date().toISOString(),
        source_file: path.basename(sourceFile),
        classification_status: classification.status,
        analysis_status: semantic.analysis ? "accepted" : "rejected",
        analysis_issues: semantic.issues
      },
      null,
      2
    ),
    "utf8"
  );
  if (!accepted || !semantic.analysis) {
    let repairRequestPath: string | null = null;
    if (semantic.analysis && classification.missing_comment_ids.length > 0) {
      repairRequestPath = path.join(taskDir, "gpt_repair_request.json");
      const missingIds = new Set(classification.missing_comment_ids);
      await writeFile(
        path.join(resultDir, "analysis-candidate.json"),
        JSON.stringify(semantic.analysis, null, 2),
        "utf8"
      );
      await writeFile(
        repairRequestPath,
        JSON.stringify(
          {
            schema_version: "1.0",
            task_type: "xhs_classification_partial_repair",
            task_id: noteEnvelope.task_id,
            instructions: [
              "只重新分类 comments 中列出的评论。",
              "只返回严格JSON对象，不使用Markdown代码块。",
              "classifications必须逐条覆盖全部comments，不能遗漏或创造comment_id。",
              "字段格式必须与classification_schema完全一致。"
            ],
            failed_comment_ids: classification.missing_comment_ids,
            comments: comments
              .filter((comment) => missingIds.has(comment.local_comment_id))
              .map((comment) => ({
                comment_id: comment.local_comment_id,
                parent_comment_id: comment.parent_comment_id,
                root_comment_id: comment.root_comment_id,
                comment_level: comment.comment_level,
                content: comment.content,
                like_count: comment.like_count,
                reply_count: comment.reply_count
              })),
            classification_schema: {
              schema_version: "1.0",
              comment_id: "C_000001",
              primary_category: "有效分析",
              secondary_tags: [],
              stance: "中立补充",
              category_confidence: 0.9,
              stance_confidence: 0.9,
              relevance: 80,
              reasoning_quality: 70,
              information_density: 70,
              evidence_strength: 50,
              discussion_contribution: 60,
              clarity: 80,
              factual_content_type: "value_judgment",
              sarcasm: "unlikely",
              aggression_present: false,
              aggression_type: [],
              aggression_target: null,
              context_quality: "sufficient",
              context_comment_ids: ["C_000001"],
              needs_review: false,
              review_reasons: [],
              brief_reason: "简短理由"
            },
            expected_output: {
              schema_version: "1.0",
              task_id: noteEnvelope.task_id,
              classifications: []
            }
          },
          null,
          2
        ),
        "utf8"
      );
    }
    return {
      ...classification,
      status: "rejected",
      analysis_status: semantic.analysis ? "accepted" : "rejected",
      analysis_issues: semantic.issues,
      report_path: null,
      repair_request_path: repairRequestPath
    };
  }
  await writeFile(
    path.join(resultDir, "analysis_result.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        task_id: noteEnvelope.task_id,
        imported_at: new Date().toISOString(),
        ...semantic.analysis
      },
      null,
      2
    ),
    "utf8"
  );
  const report = await generatePrivateReport({
    taskDir,
    taskId: noteEnvelope.task_id,
    analysis: semantic.analysis
  });
  return {
    ...classification,
    analysis_status: "accepted",
    analysis_issues: [],
    report_path: report.reportPath,
    repair_request_path: null
  };
}

export async function importGptRepairResult(
  taskDir: string,
  sourceFile: string
): Promise<GptImportSummary> {
  const parsed = parseJsonResponse(await readFile(sourceFile, "utf8"));
  if (!isObject(parsed) || !Array.isArray(parsed.classifications)) {
    throw new Error("修复结果必须包含 classifications 数组");
  }
  const noteEnvelope = JSON.parse(
    await readFile(path.join(taskDir, "note.json"), "utf8")
  ) as { task_id: string };
  if (parsed.task_id !== noteEnvelope.task_id) throw new Error("修复结果任务ID不匹配");
  const resultDir = path.join(taskDir, "ai_results");
  const originals = (await readFile(
    path.join(resultDir, "classification-from-gpt.jsonl"),
    "utf8"
  ))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const repairedById = new Map<string, Record<string, unknown>>();
  for (const item of parsed.classifications) {
    if (isObject(item) && typeof item.comment_id === "string") {
      repairedById.set(item.comment_id, item);
    }
  }
  const merged = originals.map((item) => {
    const id = typeof item.comment_id === "string" ? item.comment_id : "";
    return repairedById.get(id) ?? item;
  });
  const mergedIds = new Set(
    merged.flatMap((item) =>
      typeof item.comment_id === "string" ? [item.comment_id] : []
    )
  );
  for (const [commentId, repaired] of repairedById) {
    if (!mergedIds.has(commentId)) merged.push(repaired);
  }
  const analysis = JSON.parse(
    await readFile(path.join(resultDir, "analysis-candidate.json"), "utf8")
  );
  const combinedPath = path.join(resultDir, "gpt-result-after-repair.json");
  await writeFile(
    combinedPath,
    JSON.stringify(
      {
        schema_version: "1.0",
        task_id: noteEnvelope.task_id,
        classifications: merged,
        analysis
      },
      null,
      2
    ),
    "utf8"
  );
  return importGptResult(taskDir, combinedPath);
}

export async function generateSemanticAnalysisUpload(
  taskDir: string
): Promise<string> {
  const noteEnvelope = JSON.parse(
    await readFile(path.join(taskDir, "note.json"), "utf8")
  ) as { task_id: string; note: unknown };
  const comments = (await readFile(path.join(taskDir, "comments.jsonl"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UnifiedComment);
  const classifications = (
    await readFile(
      path.join(taskDir, "ai_results", "classification-merged.jsonl"),
      "utf8"
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const outputPath = path.join(taskDir, "gpt_analysis_upload.json");
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        schema_version: "1.0",
        task_type: "xhs_comment_semantic_analysis",
        task_id: noteEnvelope.task_id,
        instructions: [
          "逐条分类已经完成，只生成总体语义分析。",
          "只返回严格 JSON 对象，不使用 Markdown 代码块。",
          "所有成员、代表评论和证据 ID 必须来自 comments。",
          "高频说法不等于事实，个人经历与待核验声明必须区分。",
          `每条待核验声明必须从固定 claim_type 中选择：${CLAIM_TYPES.join(", ")}。`,
          "verification_status 必须固定为 unverified；本步骤不联网、不判断声明真假。",
          "不要计算百分比，不要生成 HTML。"
        ],
        note: noteEnvelope.note,
        comments: comments.map((comment) => ({
          comment_id: comment.local_comment_id,
          parent_comment_id: comment.parent_comment_id,
          root_comment_id: comment.root_comment_id,
          comment_level: comment.comment_level,
          content: comment.content,
          like_count: comment.like_count,
          reply_count: comment.reply_count,
          created_at: comment.created_at_normalized,
          ip_location: comment.ip_location_normalized
        })),
        classifications,
        output_schema: {
          schema_version: "1.0",
          task_id: noteEnvelope.task_id,
          analysis: {
            executive_summary: "总体结论",
            sentiment_summary: "态度概述",
            main_viewpoints: [{
              viewpoint_id: "V_001",
              title: "观点标题",
              summary: "观点摘要",
              viewpoint_type: "主流观点",
              confidence: 0.85,
              member_comment_ids: ["C_000001"],
              representative_comment_ids: ["C_000001"]
            }],
            controversies: [{
              controversy_id: "X_001",
              title: "争议标题",
              summary: "争议摘要",
              evidence_comment_ids: ["C_000001"]
            }],
            high_value_comments: [{
              comment_id: "C_000001",
              reason: "高价值原因"
            }],
            consensus_statements: [{
              statement: "评论区共识",
              evidence_comment_ids: ["C_000001"]
            }],
            claims_to_verify: [{
              claim: "待外部核验声明",
              claim_type: "product_or_service_effect",
              verification_status: "unverified",
              evidence_comment_ids: ["C_000001"]
            }],
            limitations: ["采样与语境限制"]
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  return outputPath;
}

export async function importSemanticAnalysisResult(
  taskDir: string,
  sourceFile: string
): Promise<SemanticImportSummary> {
  const parsed = parseJsonResponse(await readFile(sourceFile, "utf8"));
  if (!isObject(parsed)) throw new Error("语义分析结果必须是 JSON 对象");
  const noteEnvelope = JSON.parse(
    await readFile(path.join(taskDir, "note.json"), "utf8")
  ) as { task_id: string };
  if (parsed.task_id !== undefined && parsed.task_id !== noteEnvelope.task_id) {
    throw new Error("语义分析结果任务 ID 不匹配");
  }
  const comments = (await readFile(path.join(taskDir, "comments.jsonl"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UnifiedComment);
  const semantic = validateSemanticAnalysis(
    isObject(parsed.analysis) ? parsed.analysis : parsed,
    comments.map((comment) => comment.local_comment_id)
  );
  if (!semantic.analysis) {
    return {
      status: "rejected",
      issue_count: semantic.issues.length,
      issues: semantic.issues,
      report_path: null
    };
  }
  const resultDir = path.join(taskDir, "ai_results");
  await writeFile(
    path.join(resultDir, "analysis_result.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        task_id: noteEnvelope.task_id,
        imported_at: new Date().toISOString(),
        ...semantic.analysis
      },
      null,
      2
    ),
    "utf8"
  );
  const report = await generatePrivateReport({
    taskDir,
    taskId: noteEnvelope.task_id,
    analysis: semantic.analysis
  });
  return {
    status: "accepted",
    issue_count: 0,
    issues: [],
    report_path: report.reportPath
  };
}
