import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import type {
  AuditPayload,
  CaptureEndPayload,
  CommentBatchPayload,
  NoteTarget,
  CaptureMode,
  CaptureLimit,
  UnifiedComment,
  WireComment
} from "@xhs/shared";
import {
  captureModeForLimit,
  normalizeCaptureLimit,
  parseRelativeTime
} from "@xhs/shared";
import {
  generateAnalysisPackage,
  type GeneratedPackageSummary
} from "./package-generator.js";
import { upsertTaskMetadata } from "./metadata-db.js";

export interface TaskView {
  taskId: string;
  target: NoteTarget;
  phase: "capturing" | "paused" | "completed" | "failed";
  capturedCount: number;
  duplicateCount: number;
  lastNewAt: string | null;
  stopReason: string | null;
  taskDir: string;
  fieldCompleteness: number;
  platformWriteCount: 0;
  captureMode: CaptureMode;
  captureLimit: CaptureLimit;
  samplingCounts: {
    hot: number;
    latest: number;
    currentFallback: number;
  };
  permanentRaw: boolean;
  rawExpiresAt: string | null;
  evidenceStatus: "complete" | "reduced" | "expired";
}

export interface TaskListItem {
  taskId: string;
  taskDir: string;
  title: string;
  phase: string;
  capturedCount: number;
  captureLimit: number;
  updatedAt: string;
  analysisReady: boolean;
  privateReportReady: boolean;
  shareReportReady: boolean;
  reviewPending: number;
  noteId: string | null;
  fieldCompleteness: number;
  stopReason: string | null;
}

export interface ResumeCaptureInfo {
  taskId: string;
  url: string;
  captureLimit: CaptureLimit;
  initialCount: number;
  existingPlatformIds: string[];
  existingContentKeys: string[];
  captureToken: string;
}

interface TaskState extends TaskView {
  salt: string;
  nextId: number;
  seenBatchKeys: Set<string>;
  seenCommentKeys: Set<string>;
  captureKeyToLocalId: Map<string, string>;
  processedBatches: Array<{
    batch_no: number;
    checksum: string;
    received_count: number;
  }>;
  packageSummary: GeneratedPackageSummary | null;
}

export class TaskStore {
  private active: TaskState | null = null;

  constructor(private outputRoot: string) {}

  setOutputRoot(outputRoot: string): void {
    if (this.active?.phase === "capturing") {
      throw new Error("采集进行中时不能更改输出目录");
    }
    this.outputRoot = outputRoot;
  }

  getOutputRoot(): string {
    return this.outputRoot;
  }

  getView(): TaskView | null {
    if (!this.active) return null;
    const {
      salt: _salt,
      nextId: _nextId,
      seenBatchKeys: _b,
      seenCommentKeys: _c,
      captureKeyToLocalId: _captureKeyToLocalId,
      processedBatches: _p,
      packageSummary: _packageSummary,
      ...view
    } =
      this.active;
    return view;
  }

  async listTasks(): Promise<TaskListItem[]> {
    let entries;
    try {
      entries = await readdir(this.outputRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const tasks = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("task_"))
        .map(async (entry): Promise<TaskListItem | null> => {
          const taskDir = path.join(this.outputRoot, entry.name);
          const manifest = await readJsonIfPresent<Record<string, any>>(
            path.join(taskDir, "manifest.json")
          );
          if (!manifest || typeof manifest.task_id !== "string") return null;
          const queue = await readJsonIfPresent<{
            items?: Array<{ review_status?: string }>;
          }>(path.join(taskDir, "ai_results", "review-queue.json"));
          return {
            taskId: manifest.task_id,
            taskDir,
            title: String(manifest.target?.title ?? manifest.target?.normalized_url ?? entry.name),
            phase: String(manifest.capture?.phase ?? "unknown"),
            capturedCount: Number(manifest.capture?.captured_count ?? 0),
            captureLimit: Number(manifest.capture?.requested_limit ?? 50),
            updatedAt: String(manifest.updated_at ?? ""),
            analysisReady: await fileExists(
              path.join(taskDir, "ai_results", "analysis_result.json")
            ),
            privateReportReady: await fileExists(
              path.join(taskDir, "report_private", "index.html")
            ),
            shareReportReady: await fileExists(path.join(taskDir, "report_share.html")),
            reviewPending:
              queue?.items?.filter((item) => item.review_status !== "reviewed").length ?? 0,
            noteId: manifest.target?.note_id ?? null,
            fieldCompleteness: Number(
              manifest.capture?.field_completeness_percent ?? 0
            ),
            stopReason: manifest.capture?.stop_reason ?? null
          };
        })
    );
    const sorted = tasks
      .filter((task): task is TaskListItem => task !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await Promise.all(
      sorted.map((task) =>
        upsertTaskMetadata(this.outputRoot, {
          task_id: task.taskId,
          task_dir: task.taskDir,
          note_id: task.noteId,
          title: task.title,
          phase: task.phase,
          capture_limit: task.captureLimit,
          captured_count: task.capturedCount,
          field_completeness: task.fieldCompleteness,
          stop_reason: task.stopReason,
          updated_at: task.updatedAt
        })
      )
    );
    return sorted;
  }

  async openCompletedTask(taskDir: string): Promise<TaskView> {
    if (this.active?.phase === "capturing") {
      throw new Error("采集进行中时不能切换任务");
    }
    const manifest = JSON.parse(
      await readFile(path.join(taskDir, "manifest.json"), "utf8")
    ) as Record<string, any>;
    const commentsText = await readFile(path.join(taskDir, "comments.jsonl"), "utf8");
    const comments = commentsText
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UnifiedComment);
    if (
      manifest.schema_version !== "1.0" ||
      typeof manifest.task_id !== "string" ||
      !manifest.target ||
      typeof manifest.target.normalized_url !== "string"
    ) {
      throw new Error("所选目录不是有效的小红书评论任务");
    }
    const captureLimit = normalizeCaptureLimit(manifest.capture?.requested_limit);
    const checkpoint = await readJsonIfPresent<{
      processed_batches?: TaskState["processedBatches"];
    }>(path.join(taskDir, "checkpoint.json"));
    const captureKeyToLocalId = new Map<string, string>();
    const seenCommentKeys = new Set<string>();
    for (const comment of comments) {
      if (comment.platform_comment_id) {
        const key = `platform:${comment.platform_comment_id}`;
        captureKeyToLocalId.set(key, comment.local_comment_id);
        seenCommentKeys.add(key);
      }
      seenCommentKeys.add(`fingerprint:${comment.content_fingerprint}:${comment.author_local_id ?? "anonymous"}`);
    }
    this.outputRoot = path.dirname(taskDir);
    this.active = {
      taskId: manifest.task_id,
      target: manifest.target as NoteTarget,
      phase: manifest.capture?.phase === "completed" ? "completed" : "paused",
      capturedCount: comments.length,
      duplicateCount: Number(manifest.capture?.duplicates_merged ?? 0),
      lastNewAt: manifest.capture?.last_new_at ?? null,
      stopReason: manifest.capture?.stop_reason ?? "opened_existing_task",
      taskDir,
      fieldCompleteness: Number(manifest.capture?.field_completeness_percent ?? 0),
      platformWriteCount: 0,
      captureMode: captureModeForLimit(captureLimit),
      captureLimit,
      samplingCounts: {
        hot: Number(manifest.sampling?.interaction_priority_count ?? 0),
        latest: Number(manifest.sampling?.recent_priority_count ?? 0),
        currentFallback: Number(manifest.sampling?.current_fallback_count ?? 0)
      },
      permanentRaw: Boolean(manifest.retention?.permanent_raw),
      rawExpiresAt:
        typeof manifest.retention?.raw_expires_at === "string"
          ? manifest.retention.raw_expires_at
          : null,
      evidenceStatus: ["complete", "reduced", "expired"].includes(
        manifest.retention?.evidence_status
      )
        ? manifest.retention.evidence_status
        : "complete",
      salt: randomBytes(16).toString("hex"),
      nextId: comments.length + 1,
      seenBatchKeys: new Set(),
      seenCommentKeys,
      captureKeyToLocalId,
      processedBatches: checkpoint?.processed_batches ?? [],
      packageSummary: manifest.analysis_package ?? null
    };
    if (!(await fileExists(path.join(taskDir, "gpt_upload.json")))) {
      this.active.packageSummary = await generateAnalysisPackage({
        taskDir,
        taskId: this.active.taskId,
        target: this.active.target
      });
      await this.writeManifest();
    }
    return this.getView()!;
  }

  async prepareResume(): Promise<ResumeCaptureInfo> {
    const task = this.requireActive();
    if (task.phase !== "paused" && task.phase !== "failed") {
      throw new Error("只有已暂停或失败的任务可以恢复");
    }
    if (task.capturedCount >= task.captureLimit) {
      throw new Error("任务已经达到采集上限");
    }
    const comments = (await readFile(path.join(task.taskDir, "comments.jsonl"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UnifiedComment);
    task.phase = "capturing";
    task.stopReason = null;
    await this.appendAudit({
      action: "capture_resume_requested",
      domain: task.target.source_domain,
      result: "allowed_read",
      platform_write_count: 0
    });
    await this.writeCheckpoint("capturing");
    await this.writeManifest();
    return {
      taskId: task.taskId,
      url: task.target.normalized_url,
      captureLimit: task.captureLimit,
      initialCount: comments.length,
      existingPlatformIds: comments.flatMap((comment) =>
        comment.platform_comment_id ? [comment.platform_comment_id] : []
      ),
      existingContentKeys: comments.map((comment) =>
        resumeContentKey(comment.content, comment.created_at_raw)
      ),
      captureToken: randomUUID()
    };
  }

  async setPermanentRaw(permanent: boolean): Promise<TaskView> {
    const task = this.requireActive();
    if (task.phase === "capturing") {
      throw new Error("读取进行中不能修改原始数据保留策略");
    }
    task.permanentRaw = permanent;
    task.rawExpiresAt = permanent
      ? null
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.appendAudit({
      action: permanent
        ? "raw_retention_marked_permanent"
        : "raw_retention_returned_to_default",
      domain: task.target.source_domain,
      result: "completed",
      platform_write_count: 0
    });
    await this.writeManifest();
    return this.getView()!;
  }

  async regenerateAnalysisPackage(): Promise<TaskView> {
    const task = this.requireActive();
    if (task.phase === "capturing") {
      throw new Error("读取进行中，不能重建分析数据包");
    }
    task.packageSummary = await generateAnalysisPackage({
      taskDir: task.taskDir,
      taskId: task.taskId,
      target: task.target
    });
    await this.writeManifest();
    return this.getView()!;
  }

  async createTask(
    target: NoteTarget,
    requestedLimit: CaptureLimit = 50,
    captureMode: CaptureMode = "prototype"
  ): Promise<TaskView> {
    if (this.active?.phase === "capturing") {
      throw new Error("当前已有活动任务，请先停止");
    }
    await mkdir(this.outputRoot, { recursive: true });
    const taskId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const taskDir = path.join(this.outputRoot, `task_${taskId}`);
    await mkdir(taskDir, { recursive: false });
    const now = new Date().toISOString();
    this.active = {
      taskId,
      target,
      phase: "capturing",
      capturedCount: 0,
      duplicateCount: 0,
      lastNewAt: null,
      stopReason: null,
      taskDir,
      fieldCompleteness: 0,
      platformWriteCount: 0,
      captureMode,
      captureLimit: requestedLimit,
      samplingCounts: { hot: 0, latest: 0, currentFallback: 0 },
      permanentRaw: false,
      rawExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      evidenceStatus: "complete",
      salt: randomBytes(16).toString("hex"),
      nextId: 1,
      seenBatchKeys: new Set(),
      seenCommentKeys: new Set(),
      captureKeyToLocalId: new Map(),
      processedBatches: [],
      packageSummary: null
    };
    await Promise.all([
      writeFile(path.join(taskDir, "comments.jsonl"), "", "utf8"),
      writeFile(path.join(taskDir, "audit.jsonl"), "", "utf8"),
      this.writeJson(path.join(taskDir, "diagnostics.json"), {
        schema_version: "1.0",
        created_at: now,
        selector_capabilities: {},
        network_observer: "passive_only",
        raw_response_saved: false
      }),
      this.writeJson(path.join(taskDir, "sampling.json"), {
        schema_version: "1.0",
        status: "pending",
        strategy: "local_interaction_recency_proxy",
        source_order: "platform_current_order"
      }),
      this.writeJson(path.join(taskDir, "checkpoint.json"), {
        schema_version: "1.0",
        task_id: taskId,
        status: "capturing",
        processed_batches: [],
        captured_count: 0,
        last_local_comment_id: null,
        automatic_web_resume: false,
        updated_at: now
      }),
      this.writeManifest()
    ]);
    await this.appendAudit({
      action: "task_created",
      domain: target.source_domain,
      result: "allowed_read",
      platform_write_count: 0
    });
    return this.getView()!;
  }

  async acceptBatch(payload: CommentBatchPayload): Promise<{ accepted: number; duplicate: number }> {
    const task = this.requireActive();
    if (!Number.isInteger(payload.batch_no) || payload.batch_no < 1) {
      throw new Error("批次编号无效");
    }
    if (!Array.isArray(payload.comments) || payload.comments.length > 20) {
      throw new Error("批次评论数量超出限制");
    }
    const expected = sha256(JSON.stringify(payload.comments));
    if (expected !== payload.checksum) throw new Error("批次校验值不匹配");
    if (payload.count !== payload.comments.length) throw new Error("批次数量不匹配");
    const batchKey = `${payload.batch_no}:${payload.checksum}`;
    if (task.seenBatchKeys.has(batchKey)) return { accepted: 0, duplicate: payload.count };
    task.seenBatchKeys.add(batchKey);
    task.processedBatches.push({
      batch_no: payload.batch_no,
      checksum: payload.checksum,
      received_count: payload.count
    });

    const normalized: UnifiedComment[] = [];
    let duplicate = 0;
    for (const wire of payload.comments) {
      const wireFingerprint = sha256(normalizeContent(wire.content));
      const key = wire.platform_comment_id
        ? `platform:${wire.platform_comment_id}`
        : wire.capture_comment_key
          ? `capture:${wire.capture_comment_key}`
          : `fallback:${wire.identity_hint ?? "anonymous"}:${wireFingerprint}:${wire.created_at_raw ?? ""}`;
      if (task.seenCommentKeys.has(key)) {
        duplicate += 1;
        continue;
      }
      task.seenCommentKeys.add(key);
      const comment = this.normalizeComment(wire);
      normalized.push(comment);
    }
    if (normalized.length) {
      const lines = `${normalized.map((item) => JSON.stringify(item)).join("\n")}\n`;
      await appendFile(path.join(task.taskDir, "comments.jsonl"), lines, "utf8");
      task.capturedCount += normalized.length;
      task.lastNewAt = new Date().toISOString();
    }
    task.duplicateCount += duplicate;
    task.fieldCompleteness = await this.calculateCompleteness();
    await this.writeCheckpoint("capturing");
    await this.writeManifest();
    return { accepted: normalized.length, duplicate };
  }

  async appendAudit(audit: AuditPayload): Promise<void> {
    const task = this.requireActive();
    const safe = {
      timestamp: new Date().toISOString(),
      action: sanitizeLogText(audit.action),
      domain: sanitizeDomain(audit.domain),
      result: audit.result,
      platform_write_count: 0,
      detail: audit.detail ? sanitizeLogText(audit.detail) : undefined
    };
    await appendFile(path.join(task.taskDir, "audit.jsonl"), `${JSON.stringify(safe)}\n`, "utf8");
  }

  async finish(end: CaptureEndPayload, paused: boolean): Promise<TaskView> {
    const task = this.requireActive();
    task.phase = paused ? "paused" : end.reason === "error" ? "failed" : "completed";
    task.stopReason = end.reason;
    task.fieldCompleteness = await this.calculateCompleteness();
    await this.generateLocalSampling();
    task.packageSummary = await generateAnalysisPackage({
      taskDir: task.taskDir,
      taskId: task.taskId,
      target: task.target
    });
    await this.appendAudit({
      action: paused ? "capture_paused" : "capture_completed",
      domain: task.target.source_domain,
      result: end.reason === "error" ? "failed" : "completed",
      platform_write_count: 0,
      detail: end.reason
    });
    await this.writeJson(path.join(task.taskDir, "diagnostics.json"), {
      schema_version: "1.0",
      completed_at: new Date().toISOString(),
      selector_capabilities: end.diagnostics ?? {},
      network_observer: "passive_only",
      raw_response_saved: false
    });
    await this.writeCheckpoint(task.phase);
    await this.writeManifest();
    return this.getView()!;
  }

  private normalizeComment(wire: WireComment): UnifiedComment {
    const task = this.requireActive();
    const captured = new Date(wire.captured_at);
    const parsed = parseRelativeTime(wire.created_at_raw, captured);
    const fingerprint = sha256(normalizeContent(wire.content));
    const authorLocalId = wire.identity_hint
      ? `A_${sha256(`${task.salt}:${wire.identity_hint}`).slice(0, 12)}`
      : null;
    const localId = `C_${String(task.nextId++).padStart(6, "0")}`;
    const parentReference =
      wire.parent_comment_id ??
      (wire.parent_capture_key
        ? task.captureKeyToLocalId.get(wire.parent_capture_key) ?? null
        : null);
    const rootReference =
      wire.root_comment_id ??
      (wire.root_capture_key
        ? task.captureKeyToLocalId.get(wire.root_capture_key) ?? null
        : null);
    const sortSource =
      wire.sort_source === "hot" || wire.sort_source === "latest"
        ? wire.sort_source
        : "current";
    const sampleGroup =
      sortSource === "hot"
        ? "hot_layer"
        : sortSource === "latest"
          ? "latest_layer"
          : "current_fallback";
    const comment: UnifiedComment = {
      local_comment_id: localId,
      platform_comment_id: wire.platform_comment_id,
      note_id: task.target.note_id,
      parent_comment_id: parentReference,
      root_comment_id: rootReference,
      comment_level:
        wire.comment_level === 2 || wire.comment_level === 3
          ? wire.comment_level
          : 1,
      content: wire.content.trim().slice(0, 20_000),
      created_at_raw: wire.created_at_raw,
      created_at_normalized: parsed.normalized,
      created_at_precision: parsed.precision,
      ip_location_raw: wire.ip_location_raw,
      ip_location_normalized: normalizeIpLocation(wire.ip_location_raw),
      like_count: safeCount(wire.like_count),
      reply_count: safeCount(wire.reply_count),
      sort_source: sortSource,
      sample_group: sampleGroup,
      author_local_id: authorLocalId,
      is_note_author: wire.is_note_author,
      is_pinned: wire.is_pinned,
      comment_status: "active",
      read_source: wire.read_source,
      captured_at: wire.captured_at,
      thread_depth:
        wire.thread_depth === 1 || wire.thread_depth === 2
          ? wire.thread_depth
          : 0,
      manual_expand: wire.manual_expand === true,
      identity_source: wire.platform_comment_id ? "platform_id" : authorLocalId ? "display_hash" : "unknown",
      content_fingerprint: fingerprint,
      duplicate_status: "unique",
      first_seen_at: wire.captured_at,
      last_seen_at: wire.captured_at
    };
    if (wire.capture_comment_key) {
      task.captureKeyToLocalId.set(wire.capture_comment_key, localId);
    }
    return comment;
  }

  private async calculateCompleteness(): Promise<number> {
    const task = this.requireActive();
    if (!task.capturedCount) return 0;
    const text = await readFile(path.join(task.taskDir, "comments.jsonl"), "utf8");
    const comments = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UnifiedComment);
    const fields: (keyof UnifiedComment)[] = [
      "platform_comment_id",
      "created_at_raw",
      "ip_location_raw",
      "like_count",
      "reply_count",
      "author_local_id"
    ];
    let present = 0;
    for (const comment of comments) {
      for (const field of fields) {
        if (comment[field] !== null && comment[field] !== "") present += 1;
      }
    }
    return Math.round((present / (comments.length * fields.length)) * 100);
  }

  private async writeManifest(): Promise<void> {
    const task = this.requireActive();
    const commentsPath = path.join(task.taskDir, "comments.jsonl");
    const auditPath = path.join(task.taskDir, "audit.jsonl");
    const manifest = {
      schema_version: "1.0",
      prototype_version: "0.6.0",
      task_id: task.taskId,
      target: task.target,
      capture: {
        mode: task.captureMode,
        requested_limit: task.captureLimit,
        current_order_only: true,
        top_level_only: false,
        nested_replies_policy: "important_threads_limited",
        phase: task.phase,
        captured_count: task.capturedCount,
        duplicates_merged: task.duplicateCount,
        last_new_at: task.lastNewAt,
        stop_reason: task.stopReason,
        field_completeness_percent: task.fieldCompleteness
      },
      sampling: {
        strategy: "local_interaction_recency_proxy",
        source_order: "platform_current_order",
        interaction_priority_count: task.samplingCounts.hot,
        recent_priority_count: task.samplingCounts.latest,
        current_fallback_count: task.samplingCounts.currentFallback,
        platform_sort_claimed: false,
        status: task.phase === "capturing" ? "pending" : "local_proxy"
      },
      retention: {
        permanent_raw: task.permanentRaw,
        raw_expires_at: task.rawExpiresAt,
        evidence_status: task.evidenceStatus,
        automatic_raw_deletion: false
      },
      analysis_package: task.packageSummary,
      safety: {
        user_triggered: true,
        visible_capture: true,
        passive_network_observation_only: true,
        platform_write_count: 0
      },
      checksums: {
        comments_sha256: await fileSha256(commentsPath),
        audit_sha256: await fileSha256(auditPath),
        sampling_sha256: await fileSha256(path.join(task.taskDir, "sampling.json")),
        checkpoint_sha256: await fileSha256(path.join(task.taskDir, "checkpoint.json")),
        analysis_package_sha256: await fileSha256(
          path.join(task.taskDir, "analysis-package.json")
        ),
        batch_index_sha256: await fileSha256(
          path.join(task.taskDir, "batch-index.json")
        ),
        gpt_upload_sha256: await fileSha256(path.join(task.taskDir, "gpt_upload.json"))
      },
      updated_at: new Date().toISOString()
    };
    await this.writeJson(path.join(task.taskDir, "manifest.json"), manifest);
    await upsertTaskMetadata(this.outputRoot, {
      task_id: task.taskId,
      task_dir: task.taskDir,
      note_id: task.target.note_id,
      title: task.target.title ?? task.target.normalized_url,
      phase: task.phase,
      capture_limit: task.captureLimit,
      captured_count: task.capturedCount,
      field_completeness: task.fieldCompleteness,
      stop_reason: task.stopReason,
      updated_at: manifest.updated_at
    });
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  private async generateLocalSampling(): Promise<void> {
    const task = this.requireActive();
    const commentsPath = path.join(task.taskDir, "comments.jsonl");
    const text = await readFile(commentsPath, "utf8");
    const comments = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UnifiedComment);
    if (!comments.length) {
      task.samplingCounts = { hot: 0, latest: 0, currentFallback: 0 };
      await this.writeJson(path.join(task.taskDir, "sampling.json"), {
        schema_version: "1.0",
        status: "empty",
        strategy: "local_interaction_recency_proxy",
        source_order: "platform_current_order",
        platform_sort_claimed: false,
        interaction_priority: [],
        recent_priority: []
      });
      return;
    }

    const interactionTarget = Math.ceil(comments.length / 2);
    const ranked = comments.map((comment, captureIndex) => ({
      comment,
      captureIndex,
      score:
        Math.log1p(comment.like_count ?? 0) +
        1.5 * Math.log1p(comment.reply_count ?? 0)
    }));
    ranked.sort(
      (left, right) =>
        right.score - left.score ||
        (right.comment.reply_count ?? 0) - (left.comment.reply_count ?? 0) ||
        (right.comment.like_count ?? 0) - (left.comment.like_count ?? 0) ||
        left.captureIndex - right.captureIndex
    );
    const interaction = ranked.slice(0, interactionTarget);
    const interactionIds = new Set(
      interaction.map((item) => item.comment.local_comment_id)
    );
    const recent = ranked
      .filter((item) => !interactionIds.has(item.comment.local_comment_id))
      .sort((left, right) => {
        const leftTime = left.comment.created_at_normalized
          ? Date.parse(left.comment.created_at_normalized)
          : Number.NEGATIVE_INFINITY;
        const rightTime = right.comment.created_at_normalized
          ? Date.parse(right.comment.created_at_normalized)
          : Number.NEGATIVE_INFINITY;
        return rightTime - leftTime || left.captureIndex - right.captureIndex;
      });

    task.samplingCounts = {
      hot: interaction.length,
      latest: recent.length,
      currentFallback: 0
    };
    await this.writeJson(path.join(task.taskDir, "sampling.json"), {
      schema_version: "1.0",
      status: "complete",
      strategy: "local_interaction_recency_proxy",
      source_order: "platform_current_order",
      platform_sort_claimed: false,
      candidate_count: comments.length,
      interaction_formula:
        "log(1 + like_count) + 1.5 * log(1 + reply_count)",
      interaction_priority: interaction.map((item, index) => ({
        rank: index + 1,
        comment_id: item.comment.local_comment_id,
        interaction_score: Number(item.score.toFixed(6))
      })),
      recent_priority: recent.map((item, index) => ({
        rank: index + 1,
        comment_id: item.comment.local_comment_id,
        created_at_normalized: item.comment.created_at_normalized,
        created_at_precision: item.comment.created_at_precision
      })),
      limitations: {
        missing_like_count: comments.filter((comment) => comment.like_count === null)
          .length,
        missing_reply_count: comments.filter((comment) => comment.reply_count === null)
          .length,
        missing_normalized_time: comments.filter(
          (comment) => comment.created_at_normalized === null
        ).length,
        high_interaction_does_not_imply_truth: true,
        recent_proxy_depends_on_displayed_time: true
      }
    });
  }

  private async writeCheckpoint(status: TaskView["phase"]): Promise<void> {
    const task = this.requireActive();
    await this.writeJson(path.join(task.taskDir, "checkpoint.json"), {
      schema_version: "1.0",
      task_id: task.taskId,
      status,
      processed_batches: [...task.processedBatches].sort(
        (left, right) => left.batch_no - right.batch_no
      ),
      captured_count: task.capturedCount,
      duplicate_count: task.duplicateCount,
      last_local_comment_id:
        task.nextId > 1 ? `C_${String(task.nextId - 1).padStart(6, "0")}` : null,
      automatic_web_resume: false,
      resume_policy: "user_must_trigger",
      updated_at: new Date().toISOString()
    });
  }

  private requireActive(): TaskState {
    if (!this.active) throw new Error("没有活动任务");
    return this.active;
  }
}

export async function isWritableDirectory(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true });
    await stat(directory);
    const probe = path.join(directory, `.write-probe-${randomUUID()}`);
    await writeFile(probe, "", { flag: "wx" });
    await import("node:fs/promises").then(({ unlink }) => unlink(probe));
    return true;
  } catch {
    return false;
  }
}

export function normalizeContent(content: string): string {
  return content.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function resumeContentKey(content: string, createdAt: string | null): string {
  const normalized = content.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
  return sha256(`${normalized}|${createdAt ?? ""}`);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeIpLocation(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^IP属地[:：]?\s*/, "").trim() || null;
}

function safeCount(value: number | null): number | null {
  return Number.isInteger(value) && value !== null && value >= 0 ? value : null;
}

function sanitizeDomain(value: string): string {
  try {
    return new URL(`https://${value.replace(/^https?:\/\//, "")}`).hostname;
  } catch {
    return "invalid";
  }
}

export function sanitizeLogText(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").replace(/cookie|authorization|nickname/gi, "[redacted]").slice(0, 200);
}

async function fileSha256(filePath: string): Promise<string> {
  try {
    const value = await readFile(filePath);
    return createHash("sha256").update(value).digest("hex");
  } catch {
    return sha256("");
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
