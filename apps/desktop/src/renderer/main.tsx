import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopState } from "../preload";
import type { GptImportSummary } from "../gpt-workflow";
import type { ReviewState } from "../review-service";
import type { TaskListItem } from "../task-store";
import type { StorageStatus } from "../storage-service";
import type { CleanupPlan } from "../retention-service";
import type { ConnectionDiagnostics } from "../diagnostics-service";
import "./styles.css";

const primaryCategories = [
  "有效分析",
  "个人经历或案例",
  "事实补充",
  "提问或求证",
  "情绪表达",
  "攻击、嘲讽或标签化表达",
  "无关内容、广告或灌水",
  "无法判断"
];
const stances = [
  "支持",
  "反对",
  "部分支持或有条件支持",
  "中立补充",
  "质疑",
  "态度不明确"
];

const emptyState: DesktopState = {
  connectionCount: 0,
  outputRoot: "D:\\XHSCommentAnalyzer\\prototype",
  task: null
};

function App() {
  const [state, setState] = useState<DesktopState>(emptyState);
  const [importResult, setImportResult] = useState<GptImportSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [reviewCategory, setReviewCategory] = useState("");
  const [reviewStance, setReviewStance] = useState("");
  const [reviewTags, setReviewTags] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [cleanupPlan, setCleanupPlan] = useState<CleanupPlan | null>(null);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [semanticMessage, setSemanticMessage] = useState<string | null>(null);
  const [connectionDiagnostics, setConnectionDiagnostics] =
    useState<ConnectionDiagnostics | null>(null);

  useEffect(() => {
    void window.xhsDesktop.getState().then(setState);
    return window.xhsDesktop.onState(setState);
  }, []);

  useEffect(() => {
    if (!state.task || state.task.phase === "capturing") {
      setReview(null);
      return;
    }
    void window.xhsDesktop.getReviewState().then(setReview).catch(() => setReview(null));
  }, [state.task?.taskId, state.task?.phase]);

  useEffect(() => {
    void Promise.all([
      window.xhsDesktop.listTasks().then(setTasks),
      window.xhsDesktop.getStorageStatus().then(setStorage),
      window.xhsDesktop.getCleanupPlan().then(setCleanupPlan),
      window.xhsDesktop
        .getConnectionDiagnostics()
        .then(setConnectionDiagnostics)
    ]).catch(() => undefined);
  }, [state.task?.taskId, state.task?.phase, state.outputRoot]);

  useEffect(() => {
    const current = review?.current;
    setReviewCategory(current?.primary_category ?? "");
    setReviewStance(current?.stance ?? "");
    setReviewTags(current?.secondary_tags.join("，") ?? "");
    setReviewReason("");
  }, [review?.current?.comment_id]);

  const task = state.task;
  const navigateReview = (offset: number) => {
    if (!review?.pending_items.length) return;
    const nextIndex =
      (review.current_index + offset + review.pending_items.length) %
      review.pending_items.length;
    void window.xhsDesktop
      .getReviewState(review.pending_items[nextIndex]?.comment_id)
      .then(setReview);
  };
  const saveReview = (reason: string) => {
    if (!review?.current) return;
    setReviewSaving(true);
    setReviewError(null);
    void window.xhsDesktop.saveManualReview({
      comment_id: review.current.comment_id,
      primary_category: reviewCategory,
      stance: reviewStance,
      secondary_tags: reviewTags.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
      reason
    }).then(setReview)
      .catch((error) => setReviewError(error instanceof Error ? error.message : String(error)))
      .finally(() => setReviewSaving(false));
  };
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">本地开发版 · V0.6</span>
          <h1>小红书评论分析工具</h1>
          <p>可见、低频、单任务、只读采集</p>
        </div>
        <div className={`status ${state.connectionCount ? "online" : ""}`}>
          <span />
          {state.connectionCount ? "扩展已连接" : "等待扩展连接"}
        </div>
      </header>

      <section className="safety">
        <div>
          <strong>平台写入操作</strong>
          <span>点赞、收藏、关注、评论、私信、发布</span>
        </div>
        <b>0</b>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>当前任务</h2>
          <span className={`pill ${task?.phase ?? "idle"}`}>{phaseLabel(task?.phase)}</span>
        </div>
        {task ? (
          <>
            <dl>
              <div><dt>任务 ID</dt><dd>{task.taskId}</dd></div>
              <div><dt>目标</dt><dd className="truncate">{task.target.title ?? task.target.normalized_url}</dd></div>
              <div><dt>已读取</dt><dd>{task.capturedCount} 条</dd></div>
              <div><dt>采集模式</dt><dd>{task.captureMode} · 上限 {task.captureLimit}</dd></div>
              <div><dt>字段完整率</dt><dd>{task.fieldCompleteness}%</dd></div>
              <div>
                <dt>本地代理分层</dt>
                <dd>
                  互动优先 {task.samplingCounts.hot} / 时间优先 {task.samplingCounts.latest}
                  {task.samplingCounts.currentFallback ? ` / 当前 ${task.samplingCounts.currentFallback}` : ""}
                </dd>
              </div>
              <div><dt>最后新增</dt><dd>{formatTime(task.lastNewAt)}</dd></div>
              <div><dt>结束原因</dt><dd>{task.stopReason ?? "—"}</dd></div>
            </dl>
            <div className="quick-actions">
              {task.phase === "capturing" && (
                <button
                  className="danger"
                  onClick={() => void window.xhsDesktop.stopTask()}
                >
                  停止读取
                </button>
              )}
              {["paused", "failed"].includes(task.phase) &&
                task.capturedCount < task.captureLimit && (
                  <button
                    className="primary"
                    disabled={state.connectionCount === 0}
                    onClick={() => {
                      setImportError(null);
                      void window.xhsDesktop.resumeTask().catch((error) =>
                        setImportError(
                          error instanceof Error ? error.message : String(error)
                        )
                      );
                    }}
                  >
                    恢复读取
                  </button>
                )}
              {task.phase !== "capturing" && (
                <>
                  <button
                    className="primary"
                    onClick={() => void window.xhsDesktop.showGptUpload()}
                  >
                    1. 找到 GPT 文件
                  </button>
                  <button
                    disabled={importing}
                    onClick={() => {
                      setImporting(true);
                      setImportError(null);
                      void window.xhsDesktop.importGptResult()
                        .then((result) => {
                          if (result) {
                            setImportResult(result);
                            if (result.status === "accepted") {
                              void window.xhsDesktop.getReviewState().then(setReview);
                            }
                          }
                        })
                        .catch((error) =>
                          setImportError(
                            error instanceof Error ? error.message : String(error)
                          )
                        )
                        .finally(() => setImporting(false));
                    }}
                  >
                    {importing ? "正在处理…" : "2. 导入 GPT 结果"}
                  </button>
                  <button onClick={() => void window.xhsDesktop.openReport()}>
                    3. 打开报告
                  </button>
                </>
              )}
            </div>
            <details className="more-actions">
              <summary>更多操作</summary>
              <p>分批分析、重新生成、分享和任务文件管理</p>
              <div className="actions">
              <button
                className="danger"
                disabled={task.phase !== "capturing"}
                onClick={() => void window.xhsDesktop.stopTask()}
              >
                停止读取
              </button>
              <button
                className="primary"
                disabled={
                  !["paused", "failed"].includes(task.phase) ||
                  task.capturedCount >= task.captureLimit ||
                  state.connectionCount === 0
                }
                onClick={() => {
                  setImportError(null);
                  void window.xhsDesktop.resumeTask().catch((error) =>
                    setImportError(error instanceof Error ? error.message : String(error))
                  );
                }}
              >
                恢复读取
              </button>
              <button onClick={() => void window.xhsDesktop.openTaskDir()}>打开任务目录</button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() =>
                  void window.xhsDesktop
                    .setPermanentRaw(!task.permanentRaw)
                    .then((updated) =>
                      setState((current) => ({ ...current, task: updated }))
                    )
                }
              >
                {task.permanentRaw
                  ? "恢复原始评论 7 天保留"
                  : "永久保留原始评论"}
              </button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() => void window.xhsDesktop.showGptUpload()}
              >
                找到 GPT 上传文件
              </button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() => {
                  setBatchMessage(null);
                  void window.xhsDesktop.regenerateAnalysisPackage()
                    .then((ok) => {
                      if (ok) setBatchMessage("GPT 数据包与分批文件已按当前版本重建。");
                    })
                    .catch((error) =>
                      setBatchMessage(error instanceof Error ? error.message : String(error))
                    );
                }}
              >
                重建 GPT 数据包
              </button>
              <button
                disabled={task.phase === "capturing" || importing}
                onClick={() => {
                  setImporting(true);
                  setBatchMessage(null);
                  void window.xhsDesktop.importClassification()
                    .then((result) => {
                      if (!result) return;
                      setBatchMessage(
                        result.status === "accepted"
                          ? `分批分类已合并：${result.accepted_comment_count}/${result.expected_comment_count} 条。`
                          : `分批分类未通过：缺少 ${result.missing_comment_ids.length} 条，问题 ${result.issue_count} 项。`
                      );
                    })
                    .catch((error) =>
                      setBatchMessage(error instanceof Error ? error.message : String(error))
                    )
                    .finally(() => setImporting(false));
                }}
              >
                导入分批分类 JSONL
              </button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() => void window.xhsDesktop.showSemanticUpload()}
              >
                找到总体分析上传文件
              </button>
              <button
                disabled={task.phase === "capturing" || importing}
                onClick={() => {
                  setImporting(true);
                  setSemanticMessage(null);
                  void window.xhsDesktop.importSemanticResult()
                    .then((result) => {
                      if (!result) return;
                      setSemanticMessage(
                        result.status === "accepted"
                          ? "总体语义分析已校验并生成报告。"
                          : `总体分析未通过：${result.issues.join("；")}`
                      );
                      if (result.status === "accepted") {
                        void window.xhsDesktop.getReviewState().then(setReview);
                      }
                    })
                    .catch((error) =>
                      setSemanticMessage(error instanceof Error ? error.message : String(error))
                    )
                    .finally(() => setImporting(false));
                }}
              >
                导入总体分析 JSON
              </button>
              <button
                className="primary"
                disabled={task.phase === "capturing" || importing}
                onClick={() => {
                  setImporting(true);
                  setImportError(null);
                  void window.xhsDesktop.importGptResult()
                    .then((result) => {
                      if (result) {
                        setImportResult(result);
                        if (result.status === "accepted") {
                          void window.xhsDesktop.getReviewState().then(setReview);
                        }
                      }
                    })
                    .catch((error) =>
                      setImportError(error instanceof Error ? error.message : String(error))
                    )
                    .finally(() => setImporting(false));
                }}
              >
                {importing ? "正在校验并生成报告…" : "导入 GPT 结果 JSON"}
              </button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() => {
                  setImportError(null);
                  void window.xhsDesktop.regenerateReport()
                    .then((ok) => {
                      if (!ok) setImportError("当前任务还没有可用于重建报告的完整 AI 分析结果。");
                    })
                    .catch((error) =>
                      setImportError(error instanceof Error ? error.message : String(error))
                    );
                }}
              >
                重新计算并生成报告
              </button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() => void window.xhsDesktop.openReport()}
              >
                打开总结报告
              </button>
              <button
                disabled={task.phase === "capturing"}
                onClick={() => void window.xhsDesktop.openShareReport()}
              >
                打开脱敏分享版
              </button>
              </div>
            </details>
            {batchMessage && <p className="muted">{batchMessage}</p>}
            {semanticMessage && <p className="muted">{semanticMessage}</p>}
            {importError && <div className="import-result rejected"><strong>导入失败</strong><span>{importError}</span></div>}
            {importResult && (
              <div className={`import-result ${importResult.status}`}>
                <strong>{importResult.status === "accepted" ? "GPT结果已通过校验并生成报告" : "GPT结果未通过校验"}</strong>
                <span>
                  已接收 {importResult.accepted_comment_count}/{importResult.expected_comment_count} 条，
                  分类问题 {importResult.issue_count} 项，分析问题 {importResult.analysis_issues.length} 项
                </span>
                <small>
                  {importResult.status === "accepted"
                    ? `已生成本地统计和HTML总结；${importResult.review_count} 条进入人工复核队列。`
                    : "详情见 ai_results/classification-validation.json 和 gpt-import-validation.json。"}
                </small>
                {importResult.repair_request_path && (
                  <div className="repair-actions">
                    <button onClick={() => void window.xhsDesktop.showGptRepair()}>
                      找到局部补交文件
                    </button>
                    <button
                      className="primary"
                      disabled={importing}
                      onClick={() => {
                        setImporting(true);
                        setImportError(null);
                        void window.xhsDesktop.importGptRepair()
                          .then((result) => {
                            if (result) {
                              setImportResult(result);
                              if (result.status === "accepted") {
                                void window.xhsDesktop.getReviewState().then(setReview);
                              }
                            }
                          })
                          .catch((error) =>
                            setImportError(error instanceof Error ? error.message : String(error))
                          )
                          .finally(() => setImporting(false));
                      }}
                    >
                      导入局部修复结果
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="empty">
            <p>在 Chrome 中打开一篇小红书笔记，然后点击扩展里的“分析当前目标”。</p>
            <small>桌面端必须保持开启；原型一次只运行一个任务。</small>
          </div>
        )}
      </section>

      {review && (
        <section className="card review-card">
          <div className="section-title">
            <div>
              <h2>人工复核</h2>
              <p className="muted">
                待复核 {review.pending_count} · 已完成 {review.reviewed_count} · 总计 {review.total_count}
              </p>
            </div>
            <span className="pill">{review.pending_count ? "复核中" : "全部完成"}</span>
          </div>
          {review.current ? (
            <>
              <div className="review-nav">
                <button onClick={() => navigateReview(-1)}>上一条</button>
                <select
                  value={review.current.comment_id}
                  onChange={(event) =>
                    void window.xhsDesktop.getReviewState(event.target.value).then(setReview)
                  }
                >
                  {review.pending_items.map((item, index) => (
                    <option key={item.comment_id} value={item.comment_id}>
                      {index + 1}. {item.comment_id} · {item.comment_level === 1 ? "一级" : "楼中楼"} · {item.excerpt}
                    </option>
                  ))}
                </select>
                <button onClick={() => navigateReview(1)}>稍后处理 / 下一条</button>
              </div>
              {review.current.comment_level > 1 && (
                <div className="thread-context">
                  <h3>讨论线程上下文</h3>
                  {!review.current.context_complete && (
                    <p className="form-error">父评论或根评论缺失，请结合现有语境谨慎判断。</p>
                  )}
                  {review.current.thread_context
                    .filter((item) => !item.is_current)
                    .map((item) => (
                      <article
                        key={item.comment_id}
                        className={item.is_parent ? "context-parent" : ""}
                      >
                        <div>
                          <b>{item.comment_id}</b>
                          <span>
                            {item.is_parent
                              ? "父评论"
                              : item.is_root
                                ? "根评论"
                                : `同线程回复 · L${item.comment_level}`}
                          </span>
                          <small>赞 {item.like_count} · 回复 {item.reply_count}</small>
                        </div>
                        <p>{item.content}</p>
                      </article>
                    ))}
                  <div className="thread-arrow">↓ 当前需要复核的回复</div>
                </div>
              )}
              <div className="review-comment">
                <div>
                  <b>{review.current.comment_id}</b>
                  <span>{review.current.comment_level === 1 ? "一级评论" : `楼中楼 · L${review.current.comment_level}`}</span>
                  <span>赞 {review.current.like_count} · 回复 {review.current.reply_count}</span>
                </div>
                <p>{review.current.content}</p>
                <small>
                  进入复核原因：{review.current.review_reasons.join("、") || "AI主动标记"}
                </small>
              </div>
              <div className="review-form">
                <label>主要类别
                  <select value={reviewCategory} onChange={(event) => setReviewCategory(event.target.value)}>
                    {primaryCategories.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label>态度
                  <select value={reviewStance} onChange={(event) => setReviewStance(event.target.value)}>
                    {stances.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label className="wide">次要标签（用逗号分隔）
                  <input value={reviewTags} onChange={(event) => setReviewTags(event.target.value)} />
                </label>
                <label className="wide">复核原因
                  <textarea
                    value={reviewReason}
                    onChange={(event) => setReviewReason(event.target.value)}
                    placeholder="例如：结合上下文后应判定为条件支持"
                    maxLength={500}
                  />
                </label>
              </div>
              {reviewError && <p className="form-error">{reviewError}</p>}
              <button
                className="primary"
                disabled={reviewSaving || !reviewReason.trim()}
                onClick={() => {
                  saveReview(reviewReason);
                }}
              >
                {reviewSaving ? "保存并重新计算…" : "保存修改并进入下一条"}
              </button>
              <button
                disabled={reviewSaving}
                onClick={() => saveReview("确认AI判断无误")}
              >
                确认AI判断，无需修改
              </button>
            </>
          ) : (
            <p className="empty">待复核评论已全部处理，报告已按人工结果重新计算。</p>
          )}
        </section>
      )}

      <section className="card output">
        <div>
          <h2>数据目录</h2>
          <code>{state.outputRoot}</code>
        </div>
        <button onClick={() => void window.xhsDesktop.chooseOutput()}>选择目录</button>
        <button onClick={() => void window.xhsDesktop.openExistingTask()}>打开已有任务</button>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>任务历史</h2>
          <span className="pill">{tasks.length} 个任务</span>
        </div>
        <div className="task-library">
          {tasks.slice(0, 12).map((item) => (
            <article key={item.taskId} className={item.taskId === task?.taskId ? "active" : ""}>
              <div>
                <b>{item.title}</b>
                <small>{item.taskId} · {item.capturedCount}/{item.captureLimit} 条 · {item.phase}</small>
              </div>
              <div className="task-flags">
                {item.analysisReady && <span>已分析</span>}
                {item.privateReportReady && <span>有报告</span>}
                {item.shareReportReady && <span>可分享</span>}
                {item.reviewPending > 0 && <span>待复核 {item.reviewPending}</span>}
              </div>
              <button
                disabled={item.taskId === task?.taskId}
                onClick={() => void window.xhsDesktop.openTaskPath(item.taskDir)}
              >
                {item.taskId === task?.taskId ? "当前任务" : "打开"}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-title">
          <h2>运行诊断与存储</h2>
          <span className={`pill storage-${storage?.level ?? "normal"}`}>
            {storage?.level ?? "读取中"}
          </span>
        </div>
        <dl>
          <div><dt>扩展连接</dt><dd>{state.connectionCount ? `正常（${state.connectionCount}）` : "未连接"}</dd></div>
          <div>
            <dt>Native Host 注册</dt>
            <dd>
              {connectionDiagnostics?.status === "healthy"
                ? "正常"
                : connectionDiagnostics?.status === "warning"
                  ? "检测到其他版本"
                  : "需要修复"}
            </dd>
          </div>
          <div>
            <dt>连接诊断</dt>
            <dd>
              {connectionDiagnostics?.issue_codes.length
                ? connectionDiagnostics.issue_codes
                    .map(diagnosticIssueLabel)
                    .join("、")
                : "未发现问题"}
            </dd>
          </div>
          <div><dt>平台写入操作</dt><dd>0</dd></div>
          <div><dt>任务数据占用</dt><dd>{formatBytes(storage?.used_bytes)}</dd></div>
          <div><dt>软件硬上限</dt><dd>{formatBytes(storage?.hard_limit_bytes)}</dd></div>
          <div><dt>磁盘可用空间</dt><dd>{formatBytes(storage?.free_disk_bytes)}</dd></div>
          <div><dt>任务数量</dt><dd>{storage?.task_count ?? "—"}</dd></div>
        </dl>
        <div className="storage-bar"><i style={{ width: `${Math.min(100, (storage?.usage_ratio ?? 0) * 100)}%` }} /></div>
        <p className="muted">
          可安全清理 {formatBytes(cleanupPlan?.safe_reclaim_bytes)}；
          超过 7 天、需要人工确认的原始评论 {formatBytes(cleanupPlan?.review_reclaim_bytes)}。
          报告永不自动删除。
        </p>
        <button
          disabled={!cleanupPlan?.safe_reclaim_bytes}
          onClick={() => {
            setCleanupMessage(null);
            void window.xhsDesktop.applySafeCleanup().then((result) => {
              if (!result) return;
              setCleanupMessage(
                `已清理 ${result.removed_count} 个缓存/过期日志文件，释放 ${formatBytes(result.reclaimed_bytes)}。`
              );
              void Promise.all([
                window.xhsDesktop.getStorageStatus().then(setStorage),
                window.xhsDesktop.getCleanupPlan().then(setCleanupPlan)
              ]);
            });
          }}
        >
          安全清理缓存和过期日志
        </button>
        {cleanupMessage && <p className="muted">{cleanupMessage}</p>}
      </section>

      <section className="card">
        <h2>GPT 分析流程</h2>
        <ol className="workflow">
          <li>采集结束后点击“找到 GPT 上传文件”，上传 <code>gpt_upload.json</code>。</li>
          <li>要求 ChatGPT 只返回 JSON，并保存为 <code>gpt_result.json</code>。</li>
          <li>点击“导入 GPT 结果 JSON”，桌面端校验后生成本地总结报告。</li>
        </ol>
      </section>

      <footer>不保存账号密码、Cookie、请求头或完整网络响应。遇到验证码或登录异常立即暂停。</footer>
    </main>
  );
}

function phaseLabel(phase?: string): string {
  return {
    capturing: "读取中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    idle: "等待任务"
  }[phase ?? "idle"] ?? "未知";
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function diagnosticIssueLabel(code: string): string {
  const labels: Record<string, string> = {
    chrome_not_found: "未找到 Chrome",
    registry_entry_missing: "连接注册缺失",
    manifest_missing_or_invalid: "连接配置无效",
    host_executable_missing: "本地连接程序缺失",
    extension_origin_mismatch: "扩展 ID 不匹配",
    different_version_registered: "其他版本覆盖了连接"
  };
  return labels[code] ?? code;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
