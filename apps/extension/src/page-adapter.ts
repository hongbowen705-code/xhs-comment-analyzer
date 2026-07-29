import {
  isAllowedXhsUrl,
  normalizeXhsUrl,
  type CaptureEndPayload,
  type NoteTarget
} from "@xhs/shared";

export const COMMENT_SELECTORS = [
  "[data-comment-id]",
  ".parent-comment",
  ".comment-item",
  "[class*='parent-comment']",
  "[class*='comment-item']"
];
const REPLY_ITEM_SELECTORS = [
  ".reply-container [data-comment-id]",
  ".reply-container .comment-item",
  ".sub-comment",
  "[class*='sub-comment']",
  "[class*='reply-item']"
];

export function inspectNote(document: Document, pageUrl: string): NoteTarget {
  if (!isAllowedXhsUrl(pageUrl)) throw new Error("当前页面不是受支持的小红书笔记");
  const url = new URL(pageUrl);
  const noteId = url.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1] ?? null;
  const rawTitle = firstText(document, ["h1", "#detail-title", "[class*='title']"]) ||
    document.title.replace(/\s*-\s*小红书.*$/, "");
  const body = firstText(document, ["#detail-desc", ".note-content", "[class*='note-content']", "[class*='desc']"]);
  const hasVideo = Boolean(document.querySelector("video"));
  const hasImages = Boolean(document.querySelector("[class*='swiper'], [class*='carousel'], .note-slider"));
  return {
    normalized_url: normalizeXhsUrl(pageUrl),
    note_id: noteId,
    note_type: hasVideo ? "video" : hasImages ? "image_text" : "unknown",
    title: cleanText(rawTitle) || null,
    body: cleanText(body) || null,
    source_domain: url.hostname
  };
}

export function detectPageProblemText(
  text: string
): { reason: CaptureEndPayload["reason"]; detail: string } | null {
  const limited = text.slice(0, 100_000);
  if (/验证码|安全验证|完成验证/.test(limited)) return { reason: "captcha", detail: "检测到验证码或安全验证" };
  if (/登录后查看|请先登录|登录即可/.test(limited)) return { reason: "login_required", detail: "登录状态不可用" };
  if (/笔记不存在|内容已删除|暂时无法查看/.test(limited)) return { reason: "target_unavailable", detail: "目标不可见" };
  return null;
}

export function findTopLevelCommentNodes(document: Document): HTMLElement[] {
  const nodes = COMMENT_SELECTORS.flatMap((selector) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
  );
  return [...new Set(nodes)].filter(
    (node) => !nodes.some((other) => other !== node && other.contains(node))
  );
}

export function findNestedReplyNodes(root: HTMLElement): HTMLElement[] {
  const nodes = REPLY_ITEM_SELECTORS.flatMap((selector) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector))
  );
  return [...new Set(nodes)].filter(
    (node) => !nodes.some((other) => other !== node && other.contains(node))
  );
}

export function findReplyExpandControl(root: HTMLElement): HTMLElement | null {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>("button,[role='button'],span,a")
  );
  for (const candidate of candidates) {
    const text = cleanText(candidate.innerText || candidate.textContent || "");
    if (/收起/.test(text)) continue;
    if (
      /^(?:展开|查看|共)?\s*\d+\s*条?回复$/.test(text) ||
      /^(?:展开|查看更多|更多)\s*回复$/.test(text)
    ) {
      return (
        candidate.closest<HTMLElement>("button,[role='button'],a") ?? candidate
      );
    }
  }
  return null;
}

export function findScrollableAncestor(
  start: HTMLElement | null,
  styleFor: (element: HTMLElement) => Pick<CSSStyleDeclaration, "overflowY"> = (element) =>
    getComputedStyle(element)
): HTMLElement | null {
  let current = start?.parentElement ?? null;
  while (current && current !== current.ownerDocument.body) {
    const overflowY = styleFor(current).overflowY;
    const canScroll = current.scrollHeight > current.clientHeight + 16;
    if (canScroll && /^(auto|scroll|overlay)$/i.test(overflowY)) return current;
    current = current.parentElement;
  }
  const body = start?.ownerDocument.body;
  if (
    body &&
    body.scrollHeight > body.clientHeight + 16 &&
    /^(auto|scroll|overlay)$/i.test(styleFor(body).overflowY)
  ) {
    return body;
  }
  return null;
}

function firstText(document: Document, selectors: string[]): string {
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    const value = element?.innerText || element?.textContent;
    if (value?.trim()) return value;
  }
  return "";
}

function cleanText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
