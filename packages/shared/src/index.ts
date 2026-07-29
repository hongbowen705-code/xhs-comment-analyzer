export const SCHEMA_VERSION = "1.0" as const;
export const NATIVE_HOST_NAME = "com.xhs_comment_analyzer.prototype";
export const EXTENSION_ID = "fghibfonhbgiolhahjhagnngpcglgmje";
export const PIPE_NAME = "\\\\.\\pipe\\xhs-comment-analyzer-prototype-v1";
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export const MESSAGE_TYPES = [
  "capability_check",
  "create_task",
  "task_created",
  "start_capture",
  "stop_capture",
  "comment_batch",
  "progress",
  "capture_completed",
  "capture_paused",
  "error",
  "audit_event"
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface Envelope<T = unknown> {
  schema_version: typeof SCHEMA_VERSION;
  request_id: string;
  task_id: string | null;
  message_type: MessageType;
  sent_at: string;
  payload: T;
}

export type NoteType = "video" | "image_text" | "unknown";
export type SortSource = "hot" | "latest" | "current";
export type SampleGroup = "hot_layer" | "latest_layer" | "current_fallback";
export type CaptureMode = "prototype" | "quick" | "standard" | "deep";
export type CaptureLimit = 50 | 100 | 500 | 1000 | 2000 | 3000;

export function normalizeCaptureLimit(value: unknown): CaptureLimit {
  const numeric = Number(value);
  return numeric === 100 ||
    numeric === 500 ||
    numeric === 1000 ||
    numeric === 2000 ||
    numeric === 3000
    ? numeric
    : 50;
}

export function captureModeForLimit(limit: CaptureLimit): CaptureMode {
  return limit >= 1000
    ? "deep"
    : limit === 500
      ? "standard"
      : limit === 100
        ? "quick"
        : "prototype";
}

export interface NoteTarget {
  normalized_url: string;
  note_id: string | null;
  note_type: NoteType;
  title: string | null;
  body: string | null;
  source_domain: string;
}

export interface CreateTaskPayload {
  target: NoteTarget;
  capture_mode: CaptureMode;
  capture_limit: CaptureLimit;
}

export interface WireComment {
  platform_comment_id: string | null;
  parent_comment_id: string | null;
  root_comment_id: string | null;
  content: string;
  created_at_raw: string | null;
  ip_location_raw: string | null;
  like_count: number | null;
  reply_count: number | null;
  is_note_author: boolean;
  is_pinned: boolean;
  comment_level: 1 | 2 | 3;
  thread_depth: 0 | 1 | 2;
  capture_comment_key: string | null;
  parent_capture_key: string | null;
  root_capture_key: string | null;
  manual_expand: boolean;
  identity_hint: string | null;
  read_source: "dom" | "network" | "dom_network";
  sort_source: SortSource;
  sample_group: SampleGroup;
  captured_at: string;
}

export interface CommentBatchPayload {
  batch_no: number;
  count: number;
  checksum: string;
  retry: boolean;
  comments: WireComment[];
}

export type CreatedAtPrecision =
  | "minute"
  | "hour"
  | "day"
  | "month"
  | "year"
  | "unknown";

export interface UnifiedComment {
  local_comment_id: string;
  platform_comment_id: string | null;
  note_id: string | null;
  parent_comment_id: string | null;
  root_comment_id: string | null;
  comment_level: 1 | 2 | 3;
  content: string;
  created_at_raw: string | null;
  created_at_normalized: string | null;
  created_at_precision: CreatedAtPrecision;
  ip_location_raw: string | null;
  ip_location_normalized: string | null;
  like_count: number | null;
  reply_count: number | null;
  sort_source: SortSource;
  sample_group: SampleGroup;
  author_local_id: string | null;
  is_note_author: boolean;
  is_pinned: boolean;
  comment_status: "active" | "edited" | "deleted" | "hidden" | "unavailable" | "unknown";
  read_source: "dom" | "network" | "dom_network";
  captured_at: string;
  thread_depth: 0 | 1 | 2;
  manual_expand: boolean;
  identity_source: "platform_id" | "display_hash" | "unknown";
  content_fingerprint: string;
  duplicate_status: "unique" | "merged";
  first_seen_at: string;
  last_seen_at: string;
}

export interface ProgressPayload {
  phase: "idle" | "detecting" | "capturing" | "paused" | "completed" | "failed";
  captured_count: number;
  last_new_at: string | null;
  detail?: string;
}

export interface CaptureEndPayload {
  reason:
    | "limit_reached"
    | "no_new_comments"
    | "user_stopped"
    | "tab_closed"
    | "login_required"
    | "captcha"
    | "target_unavailable"
    | "page_unrecognized"
    | "extension_disconnected"
    | "error";
  captured_count: number;
  diagnostics?: Record<string, string | number | boolean | null>;
}

export interface AuditPayload {
  action: string;
  domain: string;
  result: "allowed_read" | "blocked" | "completed" | "failed";
  platform_write_count: 0;
  detail?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  recoverable: boolean;
}

export function createEnvelope<T>(
  messageType: MessageType,
  payload: T,
  taskId: string | null = null,
  requestId: string = crypto.randomUUID()
): Envelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    request_id: requestId,
    task_id: taskId,
    message_type: messageType,
    sent_at: new Date().toISOString(),
    payload
  };
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === SCHEMA_VERSION &&
    typeof record.request_id === "string" &&
    (record.task_id === null || typeof record.task_id === "string") &&
    typeof record.message_type === "string" &&
    MESSAGE_TYPES.includes(record.message_type as MessageType) &&
    typeof record.sent_at === "string" &&
    "payload" in record
  );
}

export function isAllowedXhsUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      (url.hostname === "www.xiaohongshu.com" ||
        url.hostname === "xiaohongshu.com") &&
      (/\/explore\/[a-zA-Z0-9]+/.test(url.pathname) ||
        /\/discovery\/item\/[a-zA-Z0-9]+/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

export function normalizeXhsUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  return url.toString();
}

export function parseRelativeTime(
  raw: string | null,
  capturedAt: Date
): { normalized: string | null; precision: CreatedAtPrecision } {
  if (!raw) return { normalized: null, precision: "unknown" };
  const text = raw.trim();
  const result = new Date(capturedAt);
  const match = text.match(/^(\d+)\s*(分钟|小时|天|个月|年)前$/);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (unit === "分钟") result.setMinutes(result.getMinutes() - amount);
    if (unit === "小时") result.setHours(result.getHours() - amount);
    if (unit === "天") result.setDate(result.getDate() - amount);
    if (unit === "个月") result.setMonth(result.getMonth() - amount);
    if (unit === "年") result.setFullYear(result.getFullYear() - amount);
    const precision: CreatedAtPrecision =
      unit === "分钟" ? "minute" : unit === "小时" ? "hour" : unit === "天" ? "day" : unit === "个月" ? "month" : "year";
    return { normalized: result.toISOString(), precision };
  }
  if (text === "昨天") {
    result.setDate(result.getDate() - 1);
    result.setHours(0, 0, 0, 0);
    return { normalized: result.toISOString(), precision: "day" };
  }
  const dateMatch = text.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (dateMatch) {
    result.setMonth(Number(dateMatch[1]) - 1, Number(dateMatch[2]));
    if (dateMatch[3] && dateMatch[4]) {
      result.setHours(Number(dateMatch[3]), Number(dateMatch[4]), 0, 0);
      return { normalized: result.toISOString(), precision: "minute" };
    }
    result.setHours(0, 0, 0, 0);
    return { normalized: result.toISOString(), precision: "day" };
  }
  return { normalized: null, precision: "unknown" };
}
