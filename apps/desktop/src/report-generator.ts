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

const CHART_COLORS = [
  "#a84455",
  "#d98278",
  "#d5a44f",
  "#6f9f8f",
  "#6689a8",
  "#8b73a8",
  "#b77f9b",
  "#7d858d"
];

function donutChartHtml(rows: Array<Record<string, unknown>>): string {
  const visibleRows = rows.filter((row) => Number(row.count ?? 0) > 0);
  const total = visibleRows.reduce(
    (sum, row) => sum + Number(row.count ?? 0),
    0
  );
  let cursor = 0;
  const segments = visibleRows.map((row, index) => {
    const start = cursor;
    cursor += Number(row.ratio ?? 0) * 100;
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start.toFixed(
      2
    )}% ${cursor.toFixed(2)}%`;
  });
  return `<div class="donut-layout"><div class="donut" style="background:conic-gradient(${
    segments.length ? segments.join(",") : "#e9e5e1 0 100%"
  })"><div><b>${escapeHtml(total)}</b><small>条评论</small></div></div><div class="legend">${visibleRows
    .map(
      (row, index) =>
        `<div><i style="background:${
          CHART_COLORS[index % CHART_COLORS.length]
        }"></i><span>${escapeHtml(row.value)}</span><b>${escapeHtml(
          row.count
        )}</b><small>${percentage(row.ratio)}</small></div>`
    )
    .join("")}</div></div>`;
}

function horizontalBarsHtml(
  rows: Array<Record<string, unknown>>,
  maxItems = 10
): string {
  const visibleRows = rows
    .filter((row) => Number(row.count ?? 0) > 0)
    .slice(0, maxItems);
  const maxCount = Math.max(
    1,
    ...visibleRows.map((row) => Number(row.count ?? 0))
  );
  return `<div class="h-bars">${visibleRows
    .map(
      (row, index) =>
        `<div class="h-row"><div class="h-label"><span>${escapeHtml(
          row.value
        )}</span><small>${escapeHtml(row.count)} · ${percentage(
          row.ratio
        )}</small></div><div class="h-track"><i style="width:${(
          (Number(row.count ?? 0) / maxCount) *
          100
        ).toFixed(1)}%;background:${
          CHART_COLORS[index % CHART_COLORS.length]
        }"></i></div></div>`
    )
    .join("")}</div>`;
}

function timelineChartHtml(rows: Array<Record<string, unknown>>): string {
  const sorted = [...rows].sort((left, right) => {
    const leftValue = String(left.value ?? "");
    const rightValue = String(right.value ?? "");
    if (leftValue === "时间未知") return 1;
    if (rightValue === "时间未知") return -1;
    return leftValue.localeCompare(rightValue);
  });
  const maxCount = Math.max(
    1,
    ...sorted.map((row) => Number(row.count ?? 0))
  );
  return `<div class="timeline-scroll"><div class="timeline">${sorted
    .map(
      (row) =>
        `<div class="time-column"><b>${escapeHtml(
          row.count
        )}</b><div><i style="height:${Math.max(
          5,
          (Number(row.count ?? 0) / maxCount) * 100
        ).toFixed(1)}%"></i></div><small>${escapeHtml(row.value)}</small></div>`
    )
    .join("")}</div></div>`;
}

function tagCloudHtml(rows: Array<Record<string, unknown>>): string {
  const visibleRows = rows
    .filter((row) => Number(row.count ?? 0) > 0)
    .slice(0, 24);
  const maxCount = Math.max(
    1,
    ...visibleRows.map((row) => Number(row.count ?? 0))
  );
  return `<div class="tag-cloud">${visibleRows
    .map(
      (row) =>
        `<span style="font-size:${(
          12 +
          (Number(row.count ?? 0) / maxCount) * 10
        ).toFixed(1)}px">${escapeHtml(row.value)} <b>${escapeHtml(
          row.count
        )}</b></span>`
    )
    .join("")}</div>`;
}

function heatmapHtml(
  crossRows: Array<Record<string, unknown>>,
  categoryRows: Array<Record<string, unknown>>,
  stanceRows: Array<Record<string, unknown>>
): string {
  const categories = categoryRows
    .filter((row) => Number(row.count ?? 0) > 0)
    .map((row) => String(row.value));
  const stances = stanceRows
    .filter((row) => Number(row.count ?? 0) > 0)
    .map((row) => String(row.value));
  const counts = new Map(
    crossRows.map((row) => [
      `${String(row.primary_category)}\u0000${String(row.stance)}`,
      Number(row.count ?? 0)
    ])
  );
  const maxCount = Math.max(1, ...counts.values());
  return `<div class="heatmap-wrap"><table class="heatmap"><thead><tr><th>类别</th>${stances
    .map((stance) => `<th>${escapeHtml(stance)}</th>`)
    .join("")}</tr></thead><tbody>${categories
    .map(
      (category) =>
        `<tr><th>${escapeHtml(category)}</th>${stances
          .map((stance) => {
            const count = counts.get(`${category}\u0000${stance}`) ?? 0;
            const opacity = count
              ? 0.16 + (count / maxCount) * 0.72
              : 0.04;
            return `<td style="background:rgba(168,68,85,${opacity.toFixed(
              2
            )})" title="${escapeHtml(category)} × ${escapeHtml(
              stance
            )}：${count}">${count || "·"}</td>`;
          })
          .join("")}</tr>`
    )
    .join("")}</tbody></table></div>`;
}

function collapseControlsHtml(group: string): string {
  return `<div class="collapse-actions"><button type="button" data-collapse-group="${escapeHtml(
    group
  )}" data-collapse-action="open">全部展开</button><button type="button" data-collapse-group="${escapeHtml(
    group
  )}" data-collapse-action="close">全部收起</button></div>`;
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
  const informationValues =
    (stats.information_values as Array<Record<string, unknown>> | undefined) ??
    [];
  const averageInformationValue = informationValues.length
    ? informationValues.reduce(
        (sum, item) => sum + Number(item.information_value ?? 0),
        0
      ) / informationValues.length
    : 0;

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小红书评论分析报告</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#252126;background:#f5f1ee;--accent:#a84455;--ink:#252126;--muted:#777078;--line:#e9e0dc}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 8% 0,#f8e9e8 0,transparent 30%),#f5f1ee}.wrap{max-width:1180px;margin:auto;padding:32px}
.report-hero,.card{background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:20px;padding:24px;margin-bottom:18px;box-shadow:0 10px 30px rgba(64,42,45,.04)}
.report-hero{padding:32px;background:linear-gradient(135deg,#fff 0,#fff8f7 64%,#f4dedf 100%)}h1{font-size:34px;letter-spacing:-1px;margin:9px 0 14px}h2{font-size:19px;margin-top:0}.muted,small{color:var(--muted)}
.metric-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}.metric{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px}.metric b{display:block;font-size:27px;color:var(--accent);margin-bottom:4px}.metric span{font-size:13px;color:var(--muted)}
.grid,.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.chart-grid .card{min-height:330px}
.donut-layout{display:grid;grid-template-columns:190px 1fr;align-items:center;gap:24px}.donut{width:180px;height:180px;border-radius:50%;display:grid;place-items:center}.donut>div{width:112px;height:112px;border-radius:50%;background:#fff;display:grid;place-content:center;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}.donut b{font-size:28px}.donut small{display:block}.legend{display:grid;gap:8px}.legend>div{display:grid;grid-template-columns:10px 1fr auto auto;gap:8px;align-items:center}.legend i{width:9px;height:9px;border-radius:50%}
.h-bars{display:grid;gap:13px}.h-label{display:flex;justify-content:space-between;gap:12px;margin-bottom:5px}.h-track{height:9px;background:#eee9e6;border-radius:99px;overflow:hidden}.h-track i{display:block;height:100%;border-radius:99px}
.timeline-scroll{overflow-x:auto;padding-bottom:6px}.timeline{height:220px;min-width:520px;display:flex;align-items:flex-end;gap:10px;border-bottom:1px solid var(--line);padding:18px 4px 0}.time-column{height:100%;min-width:54px;display:grid;grid-template-rows:20px 1fr 38px;text-align:center;gap:5px}.time-column>div{display:flex;align-items:flex-end;justify-content:center}.time-column i{display:block;width:30px;background:linear-gradient(#d98278,#a84455);border-radius:8px 8px 2px 2px}.time-column small{font-size:11px;word-break:break-all}
.tag-cloud{display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start}.tag-cloud span{padding:8px 11px;border-radius:12px;background:#f8eeee;color:#6f3943}.tag-cloud b{color:var(--accent)}
.heatmap-wrap{overflow:auto}.heatmap{width:100%;border-collapse:separate;border-spacing:4px}.heatmap th{font-size:11px;color:var(--muted);font-weight:500;padding:5px}.heatmap td{text-align:center;padding:10px 6px;border-radius:7px;font-weight:700;min-width:54px}
.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.section-heading h2{margin:0}.collapse-actions{display:flex;gap:6px}.collapse-actions button{border:1px solid var(--line);background:#fff;color:var(--muted);border-radius:9px;padding:6px 9px;cursor:pointer}.collapse-actions button:hover{color:var(--accent);border-color:#d9b9bf}
.insight-list{display:grid;gap:10px}.insight-item{border:1px solid var(--line);border-radius:14px;background:#fff;overflow:hidden}.insight-item>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px;padding:16px 18px}.insight-item>summary::-webkit-details-marker{display:none}.insight-item>summary:after{content:"展开";font-size:12px;color:var(--accent);grid-column:2}.insight-item[open]>summary:after{content:"收起"}.insight-item>summary h3{display:inline;margin:0 8px;font-size:16px}.summary-meta{color:var(--muted);font-size:12px;text-align:right}.insight-body{border-top:1px solid var(--line);padding:4px 18px 18px}.insight-body>p{line-height:1.7}.viewpoint{border-left:4px solid var(--accent);padding-left:14px}.evidence{display:grid;gap:10px}.evidence-link{display:block;color:inherit;text-decoration:none;background:#faf8f6;border:1px solid var(--line);border-radius:12px;padding:13px}.evidence-link:hover{border-color:var(--accent);transform:translateY(-1px)}.evidence-link span{float:right;color:#777;font-size:12px}.evidence p{margin:8px 0 0;line-height:1.65}.tag{display:inline-block;padding:4px 8px;background:#f2e8ea;border-radius:999px;font-size:12px}
.comment-audit>summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center}.comment-audit>summary::-webkit-details-marker{display:none}.comment-audit>summary:after{content:"展开";font-size:13px;color:var(--accent);padding:7px 11px;background:#f6eaec;border-radius:99px}.comment-audit[open]>summary:after{content:"收起"}.audit-body{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.filters{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;margin:14px 0}.filters input,.filters select{padding:10px;border:1px solid #d9d2cc;border-radius:8px;background:#fff}.comment-list{display:grid;gap:10px}.comment-row{scroll-margin-top:12px;border:1px solid var(--line);border-radius:10px;padding:14px}.comment-row:target{outline:3px solid #dca9b1}.comment-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.comment-meta small{margin-left:auto}.comment-row p{line-height:1.7}.hidden{display:none!important}.private-meta{width:100%;font-size:12px;color:var(--muted)}
@media(max-width:900px){.metric-grid{grid-template-columns:repeat(3,1fr)}.donut-layout{grid-template-columns:1fr}.donut{margin:auto}}@media(max-width:760px){.grid,.chart-grid{grid-template-columns:1fr}.metric-grid{grid-template-columns:1fr 1fr}.wrap{padding:12px}.filters{grid-template-columns:1fr}.section-heading{align-items:flex-start;flex-direction:column}.insight-item>summary{grid-template-columns:1fr}.summary-meta{text-align:left}.insight-item>summary:after{grid-column:1}}
</style></head><body><div class="wrap">
<header class="report-hero"><small>任务 ${escapeHtml(input.taskId)} · ${versions.capture_version} / ${versions.analysis_version} / ${versions.report_version} · 本地统计 + GPT语义总结</small><h1>评论分析报告</h1>
<p>${escapeHtml(input.analysis.executive_summary)}</p><p class="muted">${escapeHtml(
    input.analysis.sentiment_summary
  )}</p></header>
<section class="metric-grid"><article class="metric"><b>${escapeHtml(
    stats.classified_comment_count ?? comments.length
  )}</b><span>已分析评论</span></article><article class="metric"><b>${escapeHtml(
    stats.root_comment_count ?? 0
  )}</b><span>一级评论</span></article><article class="metric"><b>${escapeHtml(
    stats.reply_comment_count ?? 0
  )}</b><span>楼中楼回复</span></article><article class="metric"><b>${escapeHtml(
    averageInformationValue.toFixed(1)
  )}</b><span>平均信息价值 / 100</span></article><article class="metric"><b>${escapeHtml(
    manualRevisionCount
  )}</b><span>人工修订</span></article></section>
<section class="chart-grid"><div class="card"><h2>态度构成</h2><p class="muted">比例由本地程序计算。</p>${donutChartHtml(
    stanceRows
  )}</div><div class="card"><h2>内容类别</h2><p class="muted">条形长度表示相对数量。</p>${horizontalBarsHtml(
    categoryRows,
    12
  )}</div></section>
<section class="chart-grid"><div class="card"><h2>评论时间趋势</h2><p class="muted">按可证明的标准化月份聚合；未知时间单列。</p>${timelineChartHtml(
    timeRows
  )}</div><div class="card"><h2>公开 IP 属地分布</h2><p class="muted">公开属地不代表真实居住地；少于 3 条的属地已合并。</p>${horizontalBarsHtml(
    ipRows,
    12
  )}</div></section>
<section class="chart-grid"><div class="card"><h2>动态主题标签</h2><p class="muted">字号反映出现次数；明显同义标签已由本地规则合并。</p>${tagCloudHtml(
    secondaryTagRows
  )}</div><div class="card"><h2>类别 × 态度热力图</h2><p class="muted">颜色越深，组合出现次数越多。</p>${heatmapHtml(
    crossRows,
    categoryRows,
    stanceRows
  )}</div></section>
<section class="card"><div class="section-heading"><h2>主要观点</h2>${collapseControlsHtml(
    "viewpoints"
  )}</div><div class="insight-list">${input.analysis.main_viewpoints
    .map(
      (item) => {
        const enriched = enrichedViewpointMap.get(item.viewpoint_id);
        return `<details class="insight-item" data-insight-group="viewpoints"><summary><div><span class="tag">${escapeHtml(
          item.viewpoint_id
        )}</span><h3>${escapeHtml(
          item.title
        )}</h3></div><span class="summary-meta">成员 ${escapeHtml(
          enriched?.member_comment_ids.length ?? item.member_comment_ids.length
        )} · 证据 ${escapeHtml(
          item.representative_comment_ids.length
        )}</span></summary><div class="insight-body viewpoint"><p>${escapeHtml(
          item.summary
        )}</p><p class="muted">${escapeHtml(
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
        )}</div></details>`;
      }
    )
    .join("")}</div></section>
<section class="card"><div class="section-heading"><h2>争议点</h2>${collapseControlsHtml(
    "controversies"
  )}</div><div class="insight-list">${input.analysis.controversies
    .map(
      (item) =>
        `<details class="insight-item" data-insight-group="controversies"><summary><div><h3>${escapeHtml(
          item.title
        )}</h3></div><span class="summary-meta">证据 ${escapeHtml(
          item.evidence_comment_ids.length
        )}</span></summary><div class="insight-body viewpoint"><p>${escapeHtml(
          item.summary
        )}</p>${evidenceHtml(
          item.evidence_comment_ids,
          commentMap,
          classificationMap
        )}</div></details>`
    )
    .join("")}</div></section>
<section class="grid"><div class="card"><div class="section-heading"><h2>评论区共识</h2>${collapseControlsHtml(
    "consensus"
  )}</div><div class="insight-list">${input.analysis.consensus_statements
    .map(
      (item) =>
        `<details class="insight-item" data-insight-group="consensus"><summary><div><h3>${escapeHtml(
          item.statement
        )}</h3></div><span class="summary-meta">证据 ${escapeHtml(
          item.evidence_comment_ids.length
        )}</span></summary><div class="insight-body">${evidenceHtml(
          item.evidence_comment_ids,
          commentMap,
          classificationMap
        )}</div></details>`
    )
    .join("")}</div></div><div class="card"><div class="section-heading"><h2>待外部核验声明</h2>${collapseControlsHtml(
    "claims"
  )}</div><p class="muted">仅识别声明类型，全部状态均为“未核验”；软件未联网判断真假。</p><p>${claimTypeSummary || '<span class="muted">无待核验声明</span>'}</p><div class="insight-list">${normalizedClaims
    .map(
      (item) =>
        `<details class="insight-item" data-insight-group="claims"><summary><div><span class="tag">${escapeHtml(
          CLAIM_TYPE_LABELS[item.claim_type]
        )}</span> <span class="tag">未核验</span><h3>${escapeHtml(
          item.claim
        )}</h3></div><span class="summary-meta">证据 ${escapeHtml(
          item.evidence_comment_ids.length
        )}</span></summary><div class="insight-body">${evidenceHtml(
          item.evidence_comment_ids,
          commentMap,
          classificationMap
        )}</div></details>`
    )
    .join("")}</div></div></section>
<section class="card"><div class="section-heading"><h2>高价值评论</h2>${collapseControlsHtml(
    "high-value"
  )}</div><div class="insight-list">${input.analysis.high_value_comments
    .map(
      (item) =>
        `<details class="insight-item" data-insight-group="high-value"><summary><div><span class="tag">${escapeHtml(
          item.comment_id
        )}</span><h3>${escapeHtml(
          item.reason
        )}</h3></div></summary><div class="insight-body">${evidenceHtml(
          [item.comment_id],
          commentMap,
          classificationMap
        )}</div></details>`
    )
    .join("")}</div></section>
<section class="card" id="all-comments"><details class="comment-audit"><summary><div><h2>评论明细（审计用）</h2><p class="muted">完整评论保留用于搜索、筛选和证据追溯，默认折叠，不占用报告主体。</p></div></summary><div class="audit-body">
<div class="filters"><input id="comment-search" placeholder="搜索评论内容或评论ID">
<select id="stance-filter"><option value="">全部态度</option>${stanceRows
    .map((row) => `<option value="${escapeHtml(row.value)}">${escapeHtml(row.value)}</option>`)
    .join("")}</select>
<select id="category-filter"><option value="">全部类别</option>${categoryRows
    .map((row) => `<option value="${escapeHtml(row.value)}">${escapeHtml(row.value)}</option>`)
    .join("")}</select></div>
<p class="muted" id="filter-count">显示 ${comments.length} 条</p>
<div class="comment-list">${commentRowsHtml(comments, classificationMap)}</div></div></details></section>
<section class="card" id="limitations"><h2>分析局限</h2><ul>${input.analysis.limitations
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul><p class="muted">高频说法不等于事实。综合指标不代表真实性、正确性或总体代表性。</p></section>
</div><script>
(()=>{const q=document.querySelector('#comment-search'),s=document.querySelector('#stance-filter'),c=document.querySelector('#category-filter'),rows=[...document.querySelectorAll('.comment-row')],count=document.querySelector('#filter-count'),audit=document.querySelector('.comment-audit');
if(q&&s&&c&&count){const apply=()=>{const term=(q.value||'').trim().toLowerCase();let visible=0;for(const row of rows){const okText=!term||row.textContent.toLowerCase().includes(term),okStance=!s.value||row.dataset.stance===s.value,okCategory=!c.value||row.dataset.category===c.value,show=okText&&okStance&&okCategory;row.classList.toggle('hidden',!show);if(show)visible++}count.textContent='显示 '+visible+' 条'};q.addEventListener('input',apply);s.addEventListener('change',apply);c.addEventListener('change',apply)}
for(const button of document.querySelectorAll('[data-collapse-action]'))button.addEventListener('click',()=>{const group=button.dataset.collapseGroup,open=button.dataset.collapseAction==='open';for(const item of document.querySelectorAll('[data-insight-group="'+group+'"]'))item.open=open});
for(const link of document.querySelectorAll('.evidence-link'))link.addEventListener('click',()=>{if(audit)audit.open=true})})();
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
