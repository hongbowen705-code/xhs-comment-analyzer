import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

const HARD_LIMIT = 6 * 1024 ** 3;

export interface StorageStatus {
  root: string;
  used_bytes: number;
  hard_limit_bytes: number;
  usage_ratio: number;
  free_disk_bytes: number | null;
  level: "normal" | "warning" | "cleanup_required" | "blocked";
  task_count: number;
}

async function directorySize(root: string): Promise<{ bytes: number; taskCount: number }> {
  let bytes = 0;
  let taskCount = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    if (current === root) {
      taskCount += entries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("task_")
      ).length;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) {
        try {
          bytes += (await stat(fullPath)).size;
        } catch {
          // A file removed during the scan is ignored.
        }
      }
    }
  }
  return { bytes, taskCount };
}

export async function getStorageStatus(root: string): Promise<StorageStatus> {
  const { bytes, taskCount } = await directorySize(root);
  let freeDiskBytes: number | null = null;
  try {
    const disk = await statfs(root);
    freeDiskBytes = Number(disk.bavail) * Number(disk.bsize);
  } catch {
    // The output directory may not exist yet.
  }
  const level =
    bytes >= 5.8 * 1024 ** 3
      ? "blocked"
      : bytes >= 5.4 * 1024 ** 3
        ? "cleanup_required"
        : bytes >= 4.8 * 1024 ** 3
          ? "warning"
          : "normal";
  return {
    root,
    used_bytes: bytes,
    hard_limit_bytes: HARD_LIMIT,
    usage_ratio: bytes / HARD_LIMIT,
    free_disk_bytes: freeDiskBytes,
    level,
    task_count: taskCount
  };
}
