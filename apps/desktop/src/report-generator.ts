import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UnifiedComment } from "@xhs/shared";
import type { ClassificationRecord } from "./classification-importer.js";
import { upsertAnalysisMetadata, upsertTaskMetadata } from "./metadata-db.js";
import {
  CLAIM_TYPE_LABELS,
  DEFAULT_CLAIM_TYPE,
  isClaimType,
  type ClaimType,
  type ClaimVerificationStatus
} from "./claim-types.js";

export interface ViewpointResult {
  viewpoint_id: string;
  title: string;
  summary: string;
  viewpoint_type?: string | null;
  confidence?: number | null;
  member_comment_ids: string[];
  representative_comment_ids: string[];
}

export interface ControversyResult {
  controversy_id: string;
  title: string;
  summary: string;
  evidence_comment_ids: string[];
}

export interface EvidenceStatement {
  statement?: string;
  evidence_comment_ids: string[];
}

export interface VerificationClaim {
  claim: string;
  claim_type: ClaimType;
  verification_status: ClaimVerificationStatus;
  evidence_comment_ids: string[];
}

export interface SemanticAnalysisResult {
  executive_summary: string;
  sentiment_summary: string;
  main_viewpoints: ViewpointResult[];
  controversies: ControversyResult[];
  high_value_comments: Array<{ comment_id: string; reason: string }>;
  consensus_statements: EvidenceStatement[];
  claims_to_verify: VerificationClaim[];
  limitations: string[];
}

interface EnrichedViewpoint {
  viewpoint_id: string;
  title: string;
  summary: string;
  viewpoint_type: string | null;
  confidence: number | null;
  member_comment_ids: string[];
  representative_comment_ids: string[];
  root_comment_count: number;
  reply_comment_count: number;
  stance_counts: Record<string, number>;
  time_distribution: Record<string, number>;
  ip_location_distribution: Record<string, number>;
  controversy_ids: string[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percentage(value: unknown): string {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function evidenceHtml(
  ids: string[],
  comments: Map<string, UnifiedComment>,
  classifications?: Map<string, ClassificationRecord>
): string {
  if (!ids.length) return '<p class="muted">没有有效证据评论。</p>';
  return `<div class="evidence">${ids
    .map((id) => {
      const comment = comments.get(id);
      if (!comment) return "";
      const excerpt = classifications?.get(id)?.aggression_present
        ? "攻击性内容已折叠，点击跳转后查看"
        : comment.content.slice(0, 180);
      return `<a class="evidence-link" href="#comment-${escapeHtml(id)}"><b>${escapeHtml(
        id
      )}</b><span>赞 ${escapeHtml(
        comment.like_count ?? 0
      )} · 回复 ${escapeHtml(comment.reply_count ?? 0)}</span><p>${escapeHtml(
        excerpt
      )}</p></a>`;
    })
    .join("")}</div>`;
}

function commentRowsHtml(
  comments: UnifiedComment[],
  classificationMap: Map<string, ClassificationRecord>
): string {
  return comments
    .map((comment) => {
      const classification = classificationMap.get(comment.local_comment_id);
      const contentHtml = classification?.aggression_present
        ? `<details><summary>攻击性内容（默认折叠，点击查看）</summary><p>${escapeHtml(
            comment.content
          )}</p></details>`
        : `<p>${escapeHtml(comment.content)}</p>`;
      return `<article class="comment-row" id="comment-${escapeHtml(
        comment.local_comment_id
      )}" data-stance="${escapeHtml(classification?.stance)}" data-category="${escapeHtml(
        classification?.primary_category
      )}"><div class="comment-meta"><b>${escapeHtml(comment.local_comment_id)}</b><span class="tag">${escapeHtml(
        classification?.primary_category ?? "未分类"
      )}</span><span class="tag">${escapeHtml(
        classification?.stance ?? "未分类"
      )}</span><small>赞 ${escapeHtml(comment.like_count ?? 0)} · 回复 ${escapeHtml(
        comment.reply_count ?? 0
      )}</small><span class="private-meta">时间 ${escapeHtml(
        comment.created_at_raw ?? "未知"
      )} · 公开IP属地 ${escapeHtml(
        comment.ip_location_normalized ?? "未知"
      )}</span></div>${contentHtml}</article>`;
    })
    .join("");
}

export async function generatePrivateReport(input: {
  taskDir: string;
  taskId: string;
  analysis: SemanticAnalysisResult;
}): Promise<{ reportPath: string; sharePath: string; checksum: string }> {
  const commentsText = await readFile(path.join(input.taskDir, "comments.jsonl"), "utf8");
  const comments = commentsText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UnifiedComment);
  const commentMap = new Map(comments.map((comment) => [comment.local_comment_id, comment]));
  const classificationText = await readFile(
    path.join(input.taskDir, "ai_results", "classification-merged.jsonl"),
    "utf8"
  );
  const classifications = classificationText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ClassificationRecord);
  const classificationMap = new Map(
    classifications.map((record) => [record.comment_id, record])
  );
  const enrichedViewpoints = enrichViewpoints(
    input.analysis,
    commentMap,
    classificationMap
  );
  const enrichedViewpointMap = new Map(
    enrichedViewpoints.map((item) => [item.viewpoint_id, item])
  );
  const stats = JSON.parse(
    await readFile(path.join(input.taskDir, "ai_results", "analysis-stats.json"), "utf8")
  ) as Record<string, unknown>;
  const manifest = await readJsonOptional<Record<string, any>>(
    path.join(input.taskDir, "manifest.json")
  );
  const revisionsText = await readTextOptional(
    path.join(input.taskDir, "ai_results", "manual-revisions.jsonl")
  );
  const manualRevisionCount = revisionsText.split(/\r?\n/).filter(Boolean).length;
  const reportDir = path.join(input.taskDir, "report_private");
  await mkdir(reportDir, { recursive: true });
  const previousVersion = await readJsonOptional<{ sequence?: number }>(
    path.join(reportDir, "report-version.json")
  );
  const reportSequence = Math.max(1, Number(previousVersion?.sequence ?? 0) + 1);
  const versions = {
    capture_version: "C01",
    analysis_version: `A${String(1 + manualRevisionCount).padStart(2, "0")}`,
    report_version: `R${String(reportSequence).padStart(2, "0")}`,
    collector_version: String(manifest?.prototype_version ?? "unknown"),
    scoring_formula_version: "1.0",
    schema_version: "1.0",
    manual_revision_count: manualRevisionCount
  };
  const stanceRows = (stats.stance_distribution as Array<Record<string, unknown>> | undefined) ?? [];
  const categoryRows =
    (stats.primary_category_distribution as Array<Record<string, unknown>> | undefined) ?? [];
  const timeRows =
    (stats.time_distribution as Array<Record<string, unknown>> | undefined) ?? [];
  const ipRows =
    (stats.ip_location_distribution as Array<Record<string, unknown>> | undefined) ?? [];
  const secondaryTagRows =
    (stats.secondary_tag_distribution as Array<Record<string, unknown>> | undefined) ?? [];
  const crossRows =
    (stats.category_stance_cross_table as Array<Record<string, unknown>> | undefined) ?? [];
  const normalizedClaims = input.analysis.claims_to_verify.map((claim) => ({
    ...claim,
    claim_type: isClaimType(claim.claim_type)
      ? claim.claim_type
      : DEFAULT_CLAIM_TYPE,
    verification_status: "unverified" as const
  }));
  const claimTypeCounts = normalizedClaims.reduce<Record<string, number>>(
    (counts, claim) => {
      counts[claim.claim_type] = (counts[claim.claim_type] ?? 0) + 1;
      return counts;
    },
    {}
  );
  const claimTypeSummary = Object.entries(claimTypeCounts)
    .map(
      ([claimType, count]) =>
        `<span class="tag">${escapeHtml(
          CLAIM_TYPE_LABELS[claimType as ClaimType] ?? claimType
        )} ${count}</span>`
    )
    .join(" ");

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小红书评论分析报告</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#20242b;background:#f6f4f1}
body{margin:0}.wrap{max-width:1080px;margin:auto;padding:28px}header,.card{background:#fff;border:1px solid #e3ddd7;border-radius:16px;padding:22px;margin-bottom:18px}
h1{margin:4px 0 8px}h2{font-size:19px}.muted,small{color:#747b86}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #eee}th{color:#6a7079}
.bar{height:7px;background:#eee7e2;border-radius:99px;overflow:hidden;min-width:90px}.bar i{display:block;height:100%;background:#a84455}
.viewpoint{border-left:4px solid #a84455;padding-left:14px;margin:18px 0}.evidence{display:grid;gap:10px}
.evidence-link{display:block;color:inherit;text-decoration:none;background:#faf8f6;border:1px solid #ebe4de;border-radius:10px;padding:12px}.evidence-link:hover{border-color:#a84455}
.evidence-link span{float:right;color:#777;font-size:12px}.evidence p{margin:8px 0 0;line-height:1.65}.tag{display:inline-block;padding:4px 8px;background:#f2e8ea;border-radius:999px;font-size:12px}
.filters{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;margin:14px 0}.filters input,.filters select{padding:10px;border:1px solid #d9d2cc;border-radius:8px;background:#fff}
.comment-list{display:grid;gap:10px}.comment-row{scroll-margin-top:12px;border:1px solid #ebe4de;border-radius:10px;padding:14px}.comment-row:target{outline:3px solid #dca9b1}
.comment-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.comment-meta small{margin-left:auto}.comment-row p{line-height:1.7}.hidden{display:none!important}
.private-meta{width:100%;font-size:12px;color:#747b86}
@media(max-width:760px){.grid{grid-template-columns:1fr}.wrap{padding:12px}}
</style></head><body><div class="wrap">
<header><small>任务 ${escapeHtml(input.taskId)} · ${versions.capture_version} / ${versions.analysis_version} / ${versions.report_version} · 本地统计 + GPT语义总结</small><h1>评论分析报告</h1>
<p>${escapeHtml(input.analysis.executive_summary)}</p><p class="muted">${escapeHtml(
    input.analysis.sentiment_summary
  )}</p></header>
<section class="grid">
<div class="card"><h2>态度分布（本地计算）</h2><table><tr><th>态度</th><th>数量</th><th>比例</th></tr>${stanceRows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.count)}</td><td>${percentage(
          row.ratio
        )}</td></tr>`
    )
    .join("")}</table></div>
<div class="card"><h2>内容类别（本地计算）</h2><table><tr><th>类别</th><th>数量</th><th>比例</th></tr>${categoryRows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.count)}</td><td>${percentage(
          row.ratio
        )}</td></tr>`
    )
    .join("")}</table></div></section>
<section class="grid">
<div class="card"><h2>评论时间分布</h2><p class="muted">仅按可证明的标准化月份聚合；无法确定的时间单列。</p><table><tr><th>月份</th><th>数量</th><th>比例</th></tr>${timeRows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.count)}</td><td><div class="bar"><i style="width:${percentage(
          row.ratio
        )}"></i></div><small>${percentage(row.ratio)}</small></td></tr>`
    )
    .join("")}</table></div>
<div class="card"><h2>公开 IP 属地聚合</h2><p class="muted">这是页面公开显示的属地，不代表真实居住地；少于 3 条的属地已合并。</p><table><tr><th>属地</th><th>数量</th><th>比例</th></tr>${ipRows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.count)}</td><td><div class="bar"><i style="width:${percentage(
          row.ratio
        )}"></i></div><small>${percentage(row.ratio)}</small></td></tr>`
    )
    .join("")}</table></div></section>
<section class="grid">
<div class="card"><h2>动态次要标签</h2><p class="muted">明显同义标签已由本地规则合并；一条评论可有多个标签。</p><table><tr><th>标签</th><th>评论数</th><th>占全部评论</th></tr>${secondaryTagRows
    .slice(0, 20)
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.value)}</td><td>${escapeHtml(row.count)}</td><td>${percentage(
          row.ratio
        )}</td></tr>`
    )
    .join("")}</table></div>
<div class="card"><h2>类别 × 态度交叉表</h2><table><tr><th>类别</th><th>态度</th><th>数量</th></tr>${crossRows
    .slice(0, 30)
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.primary_category)}</td><td>${escapeHtml(
          row.stance
        )}</td><td>${escapeHtml(row.count)}</td></tr>`
    )
    .join("")}</table></div></section>
<section class="card"><h2>主要观点</h2>${input.analysis.main_viewpoints
    .map(
      (item) => {
        const enriched = enrichedViewpointMap.get(item.viewpoint_id);
        return `<div class="viewpoint"><span class="tag">${escapeHtml(item.viewpoint_id)}</span><h3>${escapeHtml(
          item.title
        )}</h3><p>${escapeHtml(item.summary)}</p><p class="muted">${escapeHtml(
          enriched?.viewpoint_type ?? "未标注观点类型"
        )} · 置信度 ${enriched?.confidence === null || enriched?.confidence === undefined
          ? "未提供"
          : percentage(enriched.confidence)} · 成员 ${escapeHtml(
          enriched?.member_comment_ids.length ?? item.member_comment_ids.length
        )} 条 · 一级 ${escapeHtml(enriched?.root_comment_count ?? 0)} · 楼中楼 ${escapeHtml(
          enriched?.reply_comment_count ?? 0
        )} · 关联争议 ${escapeHtml(enriched?.controversy_ids.join("、") || "无")}</p>${evidenceHtml(
          item.representative_comment_ids,
          commentMap,
          classificationMap
        )}</div>`;
      }
    )
    .join("")}</section>
<section class="card"><h2>争议点</h2>${input.analysis.controversies
    .map(
      (item) =>
        `<div class="viewpoint"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(
          item.summary
        )}</p>${evidenceHtml(item.evidence_comment_ids, commentMap, classificationMap)}</div>`
    )
    .join("")}</section>
<section class="grid"><div class="card"><h2>评论区共识</h2>${input.analysis.consensus_statements
    .map(
      (item) =>
        `<div class="viewpoint"><p>${escapeHtml(item.statement)}</p>${evidenceHtml(
          item.evidence_comment_ids,
          commentMap,
          classificationMap
        )}</div>`
    )
    .join("")}</div><div class="card"><h2>待外部核验声明</h2><p class="muted">仅识别声明类型，全部状态均为“未核验”；软件未联网判断真假。</p><p>${claimTypeSummary || '<span class="muted">无待核验声明</span>'}</p>${normalizedClaims
    .map(
      (item) =>
        `<div class="viewpoint"><span class="tag">${escapeHtml(
          CLAIM_TYPE_LABELS[item.claim_type]
        )}</span> <span class="tag">未核验</span><p>${escapeHtml(item.claim)}</p>${evidenceHtml(
          item.evidence_comment_ids,
          commentMap,
          classificationMap
        )}</div>`
    )
    .join("")}</div></section>
<section class="card"><h2>高价值评论</h2>${input.analysis.high_value_comments
    .map(
      (item) =>
        `<div class="viewpoint"><p>${escapeHtml(item.reason)}</p>${evidenceHtml(
          [item.comment_id],
          commentMap,
          classificationMap
        )}</div>`
    )
    .join("")}</section>
<section class="card" id="all-comments"><h2>全部评论与分类</h2>
<div class="filters"><input id="comment-search" placeholder="搜索评论内容或评论ID">
<select id="stance-filter"><option value="">全部态度</option>${stanceRows
    .map((row) => `<option value="${escapeHtml(row.value)}">${escapeHtml(row.value)}</option>`)
    .join("")}</select>
<select id="category-filter"><option value="">全部类别</option>${categoryRows
    .map((row) => `<option value="${escapeHtml(row.value)}">${escapeHtml(row.value)}</option>`)
    .join("")}</select></div>
<p class="muted" id="filter-count">显示 ${comments.length} 条</p>
<div class="comment-list">${commentRowsHtml(comments, classificationMap)}</div></section>
<section class="card" id="limitations"><h2>分析局限</h2><ul>${input.analysis.limitations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul><p class="muted">高频说法不等于事实。综合指标不代表真实性、正确性或总体代表性。</p></section>
</div><script>
(()=>{const q=document.querySelector('#comment-search'),s=document.querySelector('#stance-filter'),c=document.querySelector('#category-filter'),rows=[...document.querySelectorAll('.comment-row')],count=document.querySelector('#filter-count');
if(!q||!s||!c||!count)return;const apply=()=>{const term=(q.value||'').trim().toLowerCase();let visible=0;for(const row of rows){const okText=!term||row.textContent.toLowerCase().includes(term),okStance=!s.value||row.dataset.stance===s.value,okCategory=!c.value||row.dataset.category===c.value,show=okText&&okStance&&okCategory;row.classList.toggle('hidden',!show);if(show)visible++}count.textContent='显示 '+visible+' 条'};q.addEventListener('input',apply);s.addEventListener('change',apply);c.addEventListener('change',apply)})();
</script></body></html>`;

  const reportPath = path.join(reportDir, "index.html");
  await writeFile(reportPath, html, "utf8");
  await writeFile(
    path.join(reportDir, "report-data.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        task_id: input.taskId,
        versions,
        analysis: {
          ...input.analysis,
          claims_to_verify: normalizedClaims
        },
        stats,
        claim_type_counts: claimTypeCounts,
        viewpoints: enrichedViewpoints
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(input.taskDir, "ai_results", "viewpoint-stats.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        generated_at: new Date().toISOString(),
        calculation_owner: "local_program",
        viewpoints: enrichedViewpoints
      },
      null,
      2
    ),
    "utf8"
  );
  const checksum = createHash("sha256").update(html).digest("hex");
  await writeFile(
    path.join(reportDir, "integrity.json"),
    JSON.stringify(
      { schema_version: "1.0", generated_at: new Date().toISOString(), index_sha256: checksum },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(reportDir, "report-version.json"),
    JSON.stringify(
      { schema_version: "1.0", sequence: reportSequence, versions, generated_at: new Date().toISOString() },
      null,
      2
    ),
    "utf8"
  );
  const evidenceIds = new Set<string>([
    ...input.analysis.main_viewpoints.flatMap((item) => item.representative_comment_ids),
    ...input.analysis.controversies.flatMap((item) => item.evidence_comment_ids),
    ...input.analysis.high_value_comments.map((item) => item.comment_id),
    ...input.analysis.consensus_statements.flatMap((item) => item.evidence_comment_ids),
    ...normalizedClaims.flatMap((item) => item.evidence_comment_ids)
  ]);
  const shareComments = comments.filter((comment) => evidenceIds.has(comment.local_comment_id));
  const shareSection = `<section class="card" id="all-comments"><h2>代表性证据评论</h2><p class="muted" id="filter-count">显示 ${shareComments.length} 条</p><div class="comment-list">${commentRowsHtml(
    shareComments,
    classificationMap
  )}</div></section>`;
  const sectionStart = html.indexOf('<section class="card" id="all-comments">');
  const sectionEnd = html.indexOf('<section class="card" id="limitations">');
  let shareHtml =
    sectionStart >= 0 && sectionEnd > sectionStart
      ? `${html.slice(0, sectionStart)}${shareSection}${html.slice(sectionEnd)}`
      : html;
  shareHtml = shareHtml.replace(
    /<span class="private-meta">[\s\S]*?<\/span>/g,
    ""
  );
  const privacyFindings = [
    { code: "local_path", found: /[A-Za-z]:\\/.test(shareHtml) },
    { code: "file_uri", found: /file:\/\//i.test(shareHtml) },
    {
      code: "private_field_name",
      found: /(ip_location|author_local_id|platform_comment_id)/i.test(shareHtml)
    }
  ];
  if (privacyFindings.some((item) => item.found)) {
    throw new Error("分享版隐私扫描未通过");
  }
  const sharePath = path.join(input.taskDir, "report_share.html");
  await writeFile(sharePath, shareHtml, "utf8");
  await writeFile(
    path.join(input.taskDir, "privacy-scan.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        scanned_at: new Date().toISOString(),
        status: "passed",
        representative_comment_count: shareComments.length,
        findings: privacyFindings
      },
      null,
      2
    ),
    "utf8"
  );
  const metadataRoot = path.dirname(input.taskDir);
  await upsertTaskMetadata(metadataRoot, {
    task_id: input.taskId,
    task_dir: input.taskDir,
    note_id: String(
      manifest?.target?.note_id ?? comments[0]?.note_id ?? ""
    ) || null,
    title: String(
      manifest?.target?.title ??
        manifest?.target?.normalized_url ??
        path.basename(input.taskDir)
    ),
    phase: String(manifest?.capture?.phase ?? "completed"),
    capture_limit: Number(
      manifest?.capture?.requested_limit ?? comments.length
    ),
    captured_count: Number(
      manifest?.capture?.captured_count ?? comments.length
    ),
    field_completeness: Number(
      manifest?.capture?.field_completeness ?? 0
    ),
    stop_reason: manifest?.capture?.stop_reason
      ? String(manifest.capture.stop_reason)
      : null,
    updated_at: new Date().toISOString()
  });
  await upsertAnalysisMetadata(metadataRoot, {
    task_id: input.taskId,
    capture_version: versions.capture_version,
    analysis_version: versions.analysis_version,
    report_version: versions.report_version,
    manual_revision_count: manualRevisionCount,
    private_report_path: reportPath,
    share_report_path: sharePath,
    updated_at: new Date().toISOString()
  });
  return { reportPath, sharePath, checksum };
}

function enrichViewpoints(
  analysis: SemanticAnalysisResult,
  comments: Map<string, UnifiedComment>,
  classifications: Map<string, ClassificationRecord>
): EnrichedViewpoint[] {
  return analysis.main_viewpoints.map((viewpoint) => {
    const members = viewpoint.member_comment_ids
      .map((id) => comments.get(id))
      .filter((comment): comment is UnifiedComment => Boolean(comment));
    const stanceCounts: Record<string, number> = {};
    const timeDistribution: Record<string, number> = {};
    const rawIpCounts: Record<string, number> = {};
    for (const comment of members) {
      const stance =
        classifications.get(comment.local_comment_id)?.stance ?? "未分类";
      stanceCounts[stance] = (stanceCounts[stance] ?? 0) + 1;
      const month = comment.created_at_normalized?.slice(0, 7) ?? "时间未知";
      timeDistribution[month] = (timeDistribution[month] ?? 0) + 1;
      const ip = comment.ip_location_normalized ?? "属地未知";
      rawIpCounts[ip] = (rawIpCounts[ip] ?? 0) + 1;
    }
    const ipDistribution: Record<string, number> = {};
    for (const [ip, count] of Object.entries(rawIpCounts)) {
      const safeIp =
        ip === "属地未知" || count >= 3 ? ip : "其他（小样本）";
      ipDistribution[safeIp] = (ipDistribution[safeIp] ?? 0) + count;
    }
    return {
      viewpoint_id: viewpoint.viewpoint_id,
      title: viewpoint.title,
      summary: viewpoint.summary,
      viewpoint_type: viewpoint.viewpoint_type ?? null,
      confidence:
        typeof viewpoint.confidence === "number"
          ? viewpoint.confidence
          : null,
      member_comment_ids: viewpoint.member_comment_ids,
      representative_comment_ids: viewpoint.representative_comment_ids,
      root_comment_count: members.filter((comment) => comment.comment_level === 1).length,
      reply_comment_count: members.filter((comment) => comment.comment_level > 1).length,
      stance_counts: stanceCounts,
      time_distribution: timeDistribution,
      ip_location_distribution: ipDistribution,
      controversy_ids: analysis.controversies
        .filter((controversy) =>
          controversy.evidence_comment_ids.some((id) =>
            viewpoint.member_comment_ids.includes(id)
          )
        )
        .map((controversy) => controversy.controversy_id)
    };
  });
}

async function readTextOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJsonOptional<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
