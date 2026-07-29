import {
  createEnvelope,
  isAllowedXhsUrl,
  normalizeCaptureLimit,
  normalizeXhsUrl,
  type AuditPayload,
  type CaptureEndPayload,
  type CaptureLimit,
  type CommentBatchPayload,
  type NoteTarget,
  type WireComment
} from "@xhs/shared";
import {
  COMMENT_SELECTORS,
  detectPageProblemText,
  findNestedReplyNodes,
  findReplyExpandControl,
  findScrollableAncestor,
  findTopLevelCommentNodes,
  inspectNote
} from "./page-adapter.js";
import { maxCaptureCycles, noNewCycleThreshold } from "./capture-policy.js";

const CONTENT_SELECTORS = [".note-text", ".content", "[class*='comment-content']", ".comment-content"];
const AUTHOR_SELECTORS = [".author", ".name", "[class*='author']", "[class*='user-name']"];
const META_SELECTORS = [".date", ".location", ".info", "[class*='date']", "[class*='location']"];
const LIKE_SELECTORS = [".like", "[class*='like-count']", "[class*='like']"];
const REPLY_MARKERS = [".reply-container", ".sub-comment", "[class*='reply-container']", "[class*='sub-comment']"];

interface CaptureSession {
  taskId: string;
  token: string;
  limit: CaptureLimit;
  initialCount: number;
  batchNo: number;
  stopped: boolean;
  captured: Map<string, WireComment>;
  existingPlatformIds: Set<string>;
  existingContentKeys: Set<string>;
  networkQueue: WireComment[];
  selectorHits: Record<string, string | number | boolean>;
  expandedRootKeys: Set<string>;
  expandLimit: number;
}

let session: CaptureSession | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DETECT_TARGET") {
    try {
      sendResponse({ ok: true, target: detectTarget() });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "页面识别失败" });
    }
    return false;
  }
  if (message?.type === "START_CAPTURE") {
    if (session) {
      sendResponse({ ok: false, error: "已有采集会话" });
      return false;
    }
    session = {
      taskId: message.taskId,
      token: message.captureToken,
      limit: normalizeCaptureLimit(message.limit),
      initialCount: Math.max(0, Number(message.initialCount) || 0),
      batchNo: 0,
      stopped: false,
      captured: new Map(),
      existingPlatformIds: new Set(
        Array.isArray(message.existingPlatformIds)
          ? message.existingPlatformIds.filter((value: unknown): value is string => typeof value === "string")
          : []
      ),
      existingContentKeys: new Set(
        Array.isArray(message.existingContentKeys)
          ? message.existingContentKeys.filter((value: unknown): value is string => typeof value === "string")
          : []
      ),
      networkQueue: [],
      selectorHits: {
        sampling_strategy: "current_order_then_local_proxy"
      },
      expandedRootKeys: new Set(),
      expandLimit:
        normalizeCaptureLimit(message.limit) >= 1000
          ? 30
          : normalizeCaptureLimit(message.limit) === 500
            ? 15
            : 5
    };
    window.postMessage({
      source: "xhs-content-script",
      type: "CONFIGURE_OBSERVER",
      token: session.token
    }, location.origin);
    void runCapture(session);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "STOP_CAPTURE" && session) {
    session.stopped = true;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin || !session) return;
  const data = event.data as {
    source?: string;
    type?: string;
    token?: string;
    comments?: WireComment[];
  };
  if (
    data.source !== "xhs-passive-observer" ||
    data.type !== "PASSIVE_COMMENTS" ||
    data.token !== session.token ||
    !Array.isArray(data.comments)
  ) return;
  for (const comment of data.comments.slice(0, 100)) {
    if (isSafeWireComment(comment) && !comment.parent_comment_id) {
      session.networkQueue.push({
        ...comment,
        read_source: "network",
        sort_source: "current",
        sample_group: "current_fallback"
      });
    }
  }
});

function detectTarget(): NoteTarget {
  return inspectNote(document, location.href);
}

async function runCapture(current: CaptureSession): Promise<void> {
  await sendAudit(current, "capture_started", "allowed_read", `limit_${current.limit}`);
  let noNewCycles = 0;
  let lastSize = 0;
  try {
    for (
      let cycle = 0;
      cycle < maxCaptureCycles(current.limit) && !current.stopped;
      cycle += 1
    ) {
      const pageProblem = detectPageProblem();
      if (pageProblem) {
        await finishCapture(current, pageProblem.reason, true, pageProblem.detail);
        return;
      }
      const domComments = await collectDomComments(current);
      const candidates = [...domComments, ...current.networkQueue.splice(0)];
      const fresh: WireComment[] = [];
      for (const comment of candidates) {
        comment.sort_source = "current";
        comment.sample_group = "current_fallback";
        if (
          (comment.platform_comment_id &&
            current.existingPlatformIds.has(comment.platform_comment_id)) ||
          current.existingContentKeys.has(
            await hashText(
              `${normalizeText(comment.content)}|${comment.created_at_raw ?? ""}`
            )
          )
        ) {
          continue;
        }
        const key = comment.platform_comment_id
          ? `platform:${comment.platform_comment_id}`
          : `${comment.identity_hint ?? "anonymous"}:${await hashText(normalizeText(comment.content))}:${comment.created_at_raw ?? ""}`;
        const previous = current.captured.get(key);
        if (previous) {
          if (previous.read_source !== comment.read_source) previous.read_source = "dom_network";
          continue;
        }
        current.captured.set(key, comment);
        fresh.push(comment);
        if (totalCaptured(current) >= current.limit) break;
      }
      if (fresh.length) await sendBatch(current, fresh);
      await sendEnvelope(createEnvelope("progress", {
        phase: "capturing",
        captured_count: totalCaptured(current),
        last_new_at: fresh.length ? new Date().toISOString() : null,
        detail: `cycle_${cycle + 1}`
      }, current.taskId));

      if (totalCaptured(current) >= current.limit) {
        await finishCapture(current, "limit_reached", false);
        return;
      }
      if (await expandOneImportantThread(current)) {
        noNewCycles = 0;
        lastSize = totalCaptured(current);
        await delay(900);
        continue;
      }
      if (totalCaptured(current) === lastSize) noNewCycles += 1;
      else noNewCycles = 0;
      lastSize = totalCaptured(current);
      if (noNewCycles >= noNewCycleThreshold(current.limit)) {
        await finishCapture(
          current,
          totalCaptured(current) ? "no_new_comments" : "page_unrecognized",
          totalCaptured(current) === 0
        );
        return;
      }
      scrollComments(current);
      await delay(2000);
    }
    await finishCapture(current, current.stopped ? "user_stopped" : "no_new_comments", false);
  } catch (error) {
    await finishCapture(current, "error", true, error instanceof Error ? error.message : "采集异常");
  }
}

async function collectDomComments(current: CaptureSession): Promise<WireComment[]> {
  const nodes = findTopLevelCommentNodes(document);
  current.selectorHits.comment_candidates = nodes.length;
  const comments: WireComment[] = [];
  for (const node of nodes) {
    if (isNestedReply(node)) continue;
    const content = firstTextWithin(node, CONTENT_SELECTORS);
    if (!content || content.length > 20_000) continue;
    const authorText = firstTextWithin(node, AUTHOR_SELECTORS);
    const meta = META_SELECTORS.map((selector) => firstTextWithin(node, [selector])).filter(Boolean).join(" ");
    const createdAt = extractTime(meta);
    const ip = extractIp(meta);
    const platformId =
      safeId(node.dataset.commentId) ??
      safeId(node.getAttribute("data-id")) ??
      safeId(node.id?.match(/[a-zA-Z0-9]{8,}/)?.[0] ?? null);
    const identityHint = authorText ? await hashText(cleanText(authorText)) : null;
    const rootCaptureKey = platformId
      ? `platform:${platformId}`
      : `dom:${await hashText(
          `${identityHint ?? "anonymous"}:${cleanText(content)}:${createdAt ?? ""}`
        )}`;
    comments.push({
      platform_comment_id: platformId,
      parent_comment_id: null,
      root_comment_id: null,
      content: cleanText(content).slice(0, 20_000),
      created_at_raw: createdAt,
      ip_location_raw: ip,
      like_count: parseCount(firstTextWithin(node, LIKE_SELECTORS)),
      reply_count: parseReplyCount(node.innerText),
      is_note_author: /作者/.test(node.innerText),
      is_pinned: /置顶/.test(node.innerText),
      comment_level: 1,
      thread_depth: 0,
      capture_comment_key: rootCaptureKey,
      parent_capture_key: null,
      root_capture_key: null,
      manual_expand: current.expandedRootKeys.has(rootCaptureKey),
      identity_hint: identityHint,
      read_source: "dom",
      sort_source: "current",
      sample_group: "current_fallback",
      captured_at: new Date().toISOString()
    });
    for (const replyNode of findNestedReplyNodes(node)) {
      const replyContent = firstTextWithin(replyNode, CONTENT_SELECTORS);
      if (!replyContent || replyContent.length > 20_000) continue;
      const replyAuthor = firstTextWithin(replyNode, AUTHOR_SELECTORS);
      const replyIdentity = replyAuthor
        ? await hashText(cleanText(replyAuthor))
        : null;
      const replyMeta = META_SELECTORS.map((selector) =>
        firstTextWithin(replyNode, [selector])
      )
        .filter(Boolean)
        .join(" ");
      const replyPlatformId =
        safeId(replyNode.dataset.commentId) ??
        safeId(replyNode.getAttribute("data-id")) ??
        safeId(replyNode.id?.match(/[a-zA-Z0-9]{8,}/)?.[0] ?? null);
      const replyCaptureKey = replyPlatformId
        ? `platform:${replyPlatformId}`
        : `reply:${rootCaptureKey}:${await hashText(
            `${replyIdentity ?? "anonymous"}:${cleanText(replyContent)}:${replyMeta}`
          )}`;
      comments.push({
        platform_comment_id: replyPlatformId,
        parent_comment_id: platformId,
        root_comment_id: platformId,
        content: cleanText(replyContent).slice(0, 20_000),
        created_at_raw: extractTime(replyMeta),
        ip_location_raw: extractIp(replyMeta),
        like_count: parseCount(firstTextWithin(replyNode, LIKE_SELECTORS)),
        reply_count: 0,
        is_note_author: /作者/.test(replyNode.innerText),
        is_pinned: false,
        comment_level: 2,
        thread_depth: 1,
        capture_comment_key: replyCaptureKey,
        parent_capture_key: rootCaptureKey,
        root_capture_key: rootCaptureKey,
        manual_expand: true,
        identity_hint: replyIdentity,
        read_source: "dom",
        sort_source: "current",
        sample_group: "current_fallback",
        captured_at: new Date().toISOString()
      });
    }
  }
  return comments;
}

async function expandOneImportantThread(
  current: CaptureSession
): Promise<boolean> {
  if (current.expandedRootKeys.size >= current.expandLimit) return false;
  const candidates: Array<{
    node: HTMLElement;
    control: HTMLElement;
    key: string;
    score: number;
  }> = [];
  for (const node of findTopLevelCommentNodes(document)) {
    const control = findReplyExpandControl(node);
    if (!control) continue;
    const platformId =
      safeId(node.dataset.commentId) ??
      safeId(node.getAttribute("data-id")) ??
      null;
    const content = firstTextWithin(node, CONTENT_SELECTORS);
    const key = platformId
      ? `platform:${platformId}`
      : `expand:${await hashText(
          cleanText(content || node.innerText).slice(0, 1000)
        )}`;
    if (current.expandedRootKeys.has(key)) continue;
    const replies = parseReplyCount(node.innerText) ?? 0;
    const likes = parseCount(firstTextWithin(node, LIKE_SELECTORS)) ?? 0;
    candidates.push({
      node,
      control,
      key,
      score:
        replies * 10 +
        Math.log1p(likes) +
        Math.min(3, cleanText(content).length / 100)
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  const selected = candidates[0];
  if (!selected) return false;
  selected.node.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest"
  });
  selected.control.click();
  current.expandedRootKeys.add(selected.key);
  current.selectorHits.expanded_threads = current.expandedRootKeys.size;
  await sendAudit(current, "expand_thread", "allowed_read", "rule_selected");
  return true;
}

async function sendBatch(current: CaptureSession, comments: WireComment[]): Promise<void> {
  const batches: WireComment[][] = [];
  let pending: WireComment[] = [];
  for (const comment of comments) {
    const candidate = [...pending, comment];
    const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    if (pending.length && (bytes > 700_000 || pending.length >= 20)) {
      batches.push(pending);
      pending = [comment];
    } else {
      pending = candidate;
    }
  }
  if (pending.length) batches.push(pending);
  for (const slice of batches) {
    const payload: CommentBatchPayload = {
      batch_no: ++current.batchNo,
      count: slice.length,
      checksum: await hashText(JSON.stringify(slice)),
      retry: false,
      comments: slice
    };
    await sendEnvelope(createEnvelope("comment_batch", payload, current.taskId));
  }
}

async function finishCapture(
  current: CaptureSession,
  reason: CaptureEndPayload["reason"],
  paused: boolean,
  detail?: string
): Promise<void> {
  if (session !== current) return;
  const payload: CaptureEndPayload = {
    reason,
    captured_count: totalCaptured(current),
    diagnostics: {
      ...current.selectorHits,
      passive_network_items_seen: current.networkQueue.length,
      detail: detail?.slice(0, 160) ?? null
    }
  };
  await sendAudit(current, paused ? "capture_paused" : "capture_completed", paused ? "failed" : "completed", reason);
  await sendEnvelope(createEnvelope(paused ? "capture_paused" : "capture_completed", payload, current.taskId));
  session = null;
}

async function sendAudit(
  current: CaptureSession,
  action: string,
  result: AuditPayload["result"],
  detail?: string
): Promise<void> {
  const payload: AuditPayload = {
    action,
    domain: location.hostname,
    result,
    platform_write_count: 0,
    detail
  };
  await sendEnvelope(createEnvelope("audit_event", payload, current.taskId));
}

async function sendEnvelope(envelope: ReturnType<typeof createEnvelope>): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: "CAPTURE_ENVELOPE", envelope });
  if (!response?.ok) throw new Error(response?.error ?? "扩展后台拒绝消息");
}

function detectPageProblem(): { reason: CaptureEndPayload["reason"]; detail: string } | null {
  return detectPageProblemText(document.body?.innerText ?? document.body?.textContent ?? "");
}

function scrollComments(current: CaptureSession): void {
  const comments = findTopLevelCommentNodes(document);
  const lastComment = comments.at(-1) ?? null;
  const container = findScrollableAncestor(lastComment);
  current.selectorHits.scroll_attempts =
    Number(current.selectorHits.scroll_attempts ?? 0) + 1;
  if (container) {
    const step = Math.max(600, container.clientHeight * 0.9);
    const targetTop = Math.min(container.scrollHeight, container.scrollTop + step);
    container.scrollTo({ top: targetTop, behavior: "smooth" });
    lastComment?.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
    current.selectorHits.scroll_strategy = "nearest_scrollable_ancestor";
    current.selectorHits.scroll_container_tag = container.tagName.toLowerCase();
    current.selectorHits.scroll_container_class = sanitizeClassName(container.className);
    current.selectorHits.scroll_top = Math.round(targetTop);
    current.selectorHits.scroll_height = container.scrollHeight;
    return;
  }
  if (lastComment) {
    lastComment.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
    current.selectorHits.scroll_strategy = "last_comment_into_view";
    return;
  }
  window.scrollBy({ top: Math.max(480, window.innerHeight * 0.7), behavior: "smooth" });
  current.selectorHits.scroll_strategy = "window_fallback";
}

function isNestedReply(node: HTMLElement): boolean {
  return REPLY_MARKERS.some((selector) => {
    const reply = node.closest(selector);
    return Boolean(reply && reply !== node);
  }) || Boolean(node.parentElement?.closest(".parent-comment .comment-item"));
}

function firstTextWithin(node: HTMLElement, selectors: string[]): string {
  for (const selector of selectors) {
    const value = node.querySelector<HTMLElement>(selector)?.innerText;
    if (value?.trim()) return value;
  }
  return "";
}

function extractTime(text: string): string | null {
  return text.match(/(?:刚刚|\d+\s*(?:分钟|小时|天|个月|年)前|昨天|\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?)/)?.[0] ?? null;
}

function extractIp(text: string): string | null {
  return text.match(/IP属地[:：]?\s*[\u4e00-\u9fa5A-Za-z]+/)?.[0] ?? null;
}

function parseCount(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(万)?/);
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] ? 10_000 : 1));
}

function parseReplyCount(text: string): number | null {
  const match = text.match(/(?:展开|共)?\s*(\d+)\s*条回复/);
  return match ? Number(match[1]) : 0;
}

function safeId(value: string | null | undefined): string | null {
  return value && /^[a-zA-Z0-9_-]{6,128}$/.test(value) ? value : null;
}

function cleanText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sanitizeClassName(value: string): string {
  return value
    .split(/\s+/)
    .filter((part) => /^[a-zA-Z0-9_-]{1,64}$/.test(part))
    .slice(0, 4)
    .join(" ")
    .slice(0, 160);
}

function normalizeText(value: string): string {
  return cleanText(value).toLocaleLowerCase("zh-CN");
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSafeWireComment(value: unknown): value is WireComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.content === "string" && item.content.length > 0 && item.content.length <= 20_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function totalCaptured(current: CaptureSession): number {
  return current.initialCount + current.captured.size;
}
