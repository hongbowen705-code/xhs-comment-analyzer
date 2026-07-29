import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface TaskMetadataRecord {
  task_id: string;
  task_dir: string;
  note_id: string | null;
  title: string;
  phase: string;
  capture_limit: number;
  captured_count: number;
  field_completeness: number;
  stop_reason: string | null;
  updated_at: string;
}

export interface AnalysisMetadataRecord {
  task_id: string;
  capture_version: string;
  analysis_version: string;
  report_version: string;
  manual_revision_count: number;
  private_report_path: string | null;
  share_report_path: string | null;
  updated_at: string;
}

async function openDatabase(outputRoot: string): Promise<DatabaseSync> {
  const databaseDir = path.join(outputRoot, "database");
  await mkdir(databaseDir, { recursive: true });
  const database = new DatabaseSync(path.join(databaseDir, "metadata.sqlite"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_dir TEXT NOT NULL UNIQUE,
      note_id TEXT,
      title TEXT NOT NULL,
      phase TEXT NOT NULL,
      capture_limit INTEGER NOT NULL,
      captured_count INTEGER NOT NULL,
      field_completeness REAL NOT NULL,
      stop_reason TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_note_id ON tasks(note_id);
    CREATE TABLE IF NOT EXISTS analysis_versions (
      task_id TEXT PRIMARY KEY,
      capture_version TEXT NOT NULL,
      analysis_version TEXT NOT NULL,
      report_version TEXT NOT NULL,
      manual_revision_count INTEGER NOT NULL,
      private_report_path TEXT,
      share_report_path TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS schema_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR REPLACE INTO schema_info(key, value) VALUES ('schema_version', '1.0');
  `);
  return database;
}

export async function upsertTaskMetadata(
  outputRoot: string,
  record: TaskMetadataRecord
): Promise<void> {
  const database = await openDatabase(outputRoot);
  try {
    database.prepare(`
      INSERT INTO tasks (
        task_id, task_dir, note_id, title, phase, capture_limit,
        captured_count, field_completeness, stop_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        task_dir=excluded.task_dir,
        note_id=excluded.note_id,
        title=excluded.title,
        phase=excluded.phase,
        capture_limit=excluded.capture_limit,
        captured_count=excluded.captured_count,
        field_completeness=excluded.field_completeness,
        stop_reason=excluded.stop_reason,
        updated_at=excluded.updated_at
    `).run(
      record.task_id,
      record.task_dir,
      record.note_id,
      record.title,
      record.phase,
      record.capture_limit,
      record.captured_count,
      record.field_completeness,
      record.stop_reason,
      record.updated_at
    );
  } finally {
    database.close();
  }
}

export async function upsertAnalysisMetadata(
  outputRoot: string,
  record: AnalysisMetadataRecord
): Promise<void> {
  const database = await openDatabase(outputRoot);
  try {
    database.prepare(`
      INSERT INTO analysis_versions (
        task_id, capture_version, analysis_version, report_version,
        manual_revision_count, private_report_path, share_report_path, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        capture_version=excluded.capture_version,
        analysis_version=excluded.analysis_version,
        report_version=excluded.report_version,
        manual_revision_count=excluded.manual_revision_count,
        private_report_path=excluded.private_report_path,
        share_report_path=excluded.share_report_path,
        updated_at=excluded.updated_at
    `).run(
      record.task_id,
      record.capture_version,
      record.analysis_version,
      record.report_version,
      record.manual_revision_count,
      record.private_report_path,
      record.share_report_path,
      record.updated_at
    );
  } finally {
    database.close();
  }
}

export async function listTaskMetadata(outputRoot: string): Promise<TaskMetadataRecord[]> {
  const database = await openDatabase(outputRoot);
  try {
    return database
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
      .all() as unknown as TaskMetadataRecord[];
  } finally {
    database.close();
  }
}
