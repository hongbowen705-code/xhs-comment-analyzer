import { lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupCandidate {
  path: string;
  relative_path: string;
  kind: "cache" | "old_log" | "raw_retention_review";
  size_bytes: number;
  safe_to_auto_remove: boolean;
  reason: string;
}

export interface CleanupPlan {
  schema_version: "1.0";
  generated_at: string;
  output_root: string;
  candidates: CleanupCandidate[];
  safe_reclaim_bytes: number;
  review_reclaim_bytes: number;
  protected_rules: string[];
}

export interface CleanupResult {
  removed_count: number;
  reclaimed_bytes: number;
  failed: Array<{ relative_path: string; reason: string }>;
}

export async function createCleanupPlan(
  outputRoot: string,
  now = new Date()
): Promise<CleanupPlan> {
  const root = path.resolve(outputRoot);
  const candidates: CleanupCandidate[] = [];
  await collectSafeFiles(root, path.join(root, "cache"), "cache", 0, now, candidates);
  await collectSafeFiles(root, path.join(root, "logs"), "old_log", 30, now, candidates);

  for (const entry of await readDirectorySafe(root)) {
    if (!entry.isDirectory() || !entry.name.startsWith("task_")) continue;
    const taskDir = path.join(root, entry.name);
    const commentsPath = path.join(taskDir, "comments.jsonl");
    const reportPath = path.join(taskDir, "report_private", "index.html");
    const manifest = await readJsonSafe(
      path.join(taskDir, "manifest.json")
    );
    const commentsStat = await statFileSafe(commentsPath);
    const reportStat = await statFileSafe(reportPath);
    if (
      commentsStat &&
      reportStat &&
      manifest?.retention?.permanent_raw !== true &&
      now.getTime() - commentsStat.mtimeMs >= 7 * DAY_MS
    ) {
      candidates.push({
        path: commentsPath,
        relative_path: path.relative(root, commentsPath),
        kind: "raw_retention_review",
        size_bytes: commentsStat.size,
        safe_to_auto_remove: false,
        reason: "原始评论已超过 7 天且存在报告；需要用户逐任务确认后才能精简"
      });
    }
  }

  return {
    schema_version: "1.0",
    generated_at: now.toISOString(),
    output_root: root,
    candidates,
    safe_reclaim_bytes: candidates
      .filter((item) => item.safe_to_auto_remove)
      .reduce((sum, item) => sum + item.size_bytes, 0),
    review_reclaim_bytes: candidates
      .filter((item) => !item.safe_to_auto_remove)
      .reduce((sum, item) => sum + item.size_bytes, 0),
    protected_rules: [
      "永不自动删除报告",
      "永不自动删除 comments.jsonl",
      "只自动清理 cache 与超过 30 天的 logs",
      "不跟随符号链接",
      "所有删除目标必须位于当前输出根目录内"
    ]
  };
}

async function readJsonSafe(filePath: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

export async function applySafeCleanup(plan: CleanupPlan): Promise<CleanupResult> {
  const root = path.resolve(plan.output_root);
  const result: CleanupResult = {
    removed_count: 0,
    reclaimed_bytes: 0,
    failed: []
  };
  for (const candidate of plan.candidates.filter((item) => item.safe_to_auto_remove)) {
    const resolved = path.resolve(candidate.path);
    if (
      !isInside(root, resolved) ||
      (!isInside(path.join(root, "cache"), resolved) &&
        !isInside(path.join(root, "logs"), resolved))
    ) {
      result.failed.push({
        relative_path: candidate.relative_path,
        reason: "目标不在允许清理的目录中"
      });
      continue;
    }
    try {
      const stat = await lstat(resolved);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("只允许删除普通文件");
      }
      await rm(resolved, { force: true });
      result.removed_count += 1;
      result.reclaimed_bytes += candidate.size_bytes;
    } catch (error) {
      result.failed.push({
        relative_path: candidate.relative_path,
        reason: error instanceof Error ? error.message : "删除失败"
      });
    }
  }
  return result;
}

async function collectSafeFiles(
  root: string,
  directory: string,
  kind: "cache" | "old_log",
  minimumAgeDays: number,
  now: Date,
  output: CleanupCandidate[]
): Promise<void> {
  if (!isInside(root, directory)) return;
  for (const entry of await readDirectorySafe(directory)) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await collectSafeFiles(root, fullPath, kind, minimumAgeDays, now, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await statFileSafe(fullPath);
    if (!stat || now.getTime() - stat.mtimeMs < minimumAgeDays * DAY_MS) continue;
    output.push({
      path: fullPath,
      relative_path: path.relative(root, fullPath),
      kind,
      size_bytes: stat.size,
      safe_to_auto_remove: true,
      reason: kind === "cache" ? "可重新生成的缓存" : "超过 30 天的诊断日志"
    });
  }
}

async function readDirectorySafe(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statFileSafe(filePath: string) {
  try {
    const stat = await lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
