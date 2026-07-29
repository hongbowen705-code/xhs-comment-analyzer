type ObservedComment = {
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
  comment_level: 1 | 2;
  thread_depth: 0 | 1;
  capture_comment_key: string | null;
  parent_capture_key: string | null;
  root_capture_key: string | null;
  manual_expand: false;
  identity_hint: null;
  read_source: "network";
  sort_source: "current";
  sample_group: "current_fallback";
  captured_at: string;
};

let observerToken: string | null = null;

window.addEventListener("message", (event) => {
  if (
    event.source === window &&
    event.origin === location.origin &&
    event.data?.source === "xhs-content-script" &&
    event.data?.type === "CONFIGURE_OBSERVER" &&
    typeof event.data?.token === "string"
  ) {
    observerToken = event.data.token;
  }
});

const originalFetch = window.fetch;
window.fetch = async function (...args): Promise<Response> {
  const response = await originalFetch.apply(this, args);
  if (isLikelyCommentUrl(response.url)) void inspectResponse(response.clone());
  return response;
};

const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  async = true,
  username?: string | null,
  password?: string | null
): void {
  Reflect.apply(originalOpen, this, [method, url, async, username, password]);
  (this as XMLHttpRequest & { __xhsObservedUrl?: string }).__xhsObservedUrl = String(url);
};
XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
  const request = this as XMLHttpRequest & { __xhsObservedUrl?: string };
  if (isLikelyCommentUrl(request.__xhsObservedUrl ?? "")) {
    request.addEventListener("load", () => {
      if (request.responseType === "" || request.responseType === "text") {
        inspectText(request.responseText);
      } else if (request.responseType === "json") {
        inspectJson(request.response);
      }
    }, { once: true });
  }
  Reflect.apply(originalSend, this, [body]);
};

async function inspectResponse(response: Response): Promise<void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return;
  try {
    inspectJson(await response.json());
  } catch {
    // The original page response remains untouched; malformed clones are ignored.
  }
}

function inspectText(value: string): void {
  if (value.length > 5_000_000) return;
  try {
    inspectJson(JSON.parse(value));
  } catch {
    // Never persist raw response text.
  }
}

function inspectJson(value: unknown): void {
  if (!observerToken) return;
  const comments: ObservedComment[] = [];
  walk(value, comments, 0);
  if (!comments.length) return;
  window.postMessage({
    source: "xhs-passive-observer",
    type: "PASSIVE_COMMENTS",
    token: observerToken,
    comments: comments.slice(0, 100)
  }, location.origin);
}

function walk(value: unknown, output: ObservedComment[], depth: number): void {
  if (depth > 8 || output.length >= 100 || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  const content = firstString(item, ["content", "text", "comment_content"]);
  const id = firstString(item, ["id", "comment_id", "commentId"]);
  const parentId = firstString(item, ["parent_comment_id", "parent_id", "target_comment_id"]);
  if (content && content.length <= 20_000 && id) {
    output.push({
      platform_comment_id: safeId(id),
      parent_comment_id: safeId(parentId),
      root_comment_id: safeId(firstString(item, ["root_comment_id", "root_id"])),
      content: content.trim(),
      created_at_raw: firstString(item, ["create_time_text", "time_text", "created_at"]),
      ip_location_raw: normalizeIp(firstString(item, ["ip_location", "ip_location_name"])),
      like_count: firstNumber(item, ["like_count", "liked_count", "likes"]),
      reply_count: firstNumber(item, ["sub_comment_count", "reply_count", "replies"]),
      is_note_author: firstBoolean(item, ["is_author", "is_note_author"]),
      is_pinned: firstBoolean(item, ["is_pinned", "is_top"]),
      comment_level: parentId ? 2 : 1,
      thread_depth: parentId ? 1 : 0,
      capture_comment_key: id ? `platform:${id}` : null,
      parent_capture_key: parentId ? `platform:${parentId}` : null,
      root_capture_key: parentId ? `platform:${parentId}` : null,
      manual_expand: false,
      identity_hint: null,
      read_source: "network",
      sort_source: "current",
      sample_group: "current_fallback",
      captured_at: new Date().toISOString()
    });
    return;
  }
  for (const nested of Object.values(item)) walk(nested, output, depth + 1);
}

function isLikelyCommentUrl(url: string): boolean {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === location.origin && /comment/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function firstString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function firstBoolean(item: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => item[key] === true || item[key] === 1);
}

function safeId(value: string | null): string | null {
  return value && /^[a-zA-Z0-9_-]{6,128}$/.test(value) ? value : null;
}

function normalizeIp(value: string | null): string | null {
  return value ? `IP属地：${value.replace(/^IP属地[:：]?\s*/, "").trim()}` : null;
}
