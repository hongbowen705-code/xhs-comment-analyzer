import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  detectPageProblemText,
  findScrollableAncestor,
  findNestedReplyNodes,
  findReplyExpandControl,
  findTopLevelCommentNodes,
  inspectNote
} from "./page-adapter.js";

describe("XHS page adapter fixtures", () => {
  it("recognizes a video note and strips query tokens", () => {
    const { document } = parseHTML(`
      <html><head><title>视频标题 - 小红书</title></head>
      <body><h1>视频标题</h1><div id="detail-desc">正文</div><video></video></body></html>
    `);
    const target = inspectNote(
      document as unknown as Document,
      "https://www.xiaohongshu.com/explore/abc123?xsec_token=secret"
    );
    expect(target.note_type).toBe("video");
    expect(target.note_id).toBe("abc123");
    expect(target.normalized_url).not.toContain("secret");
  });

  it("recognizes an image-text note and top-level comments", () => {
    const { document } = parseHTML(`
      <html><body>
        <div class="note-slider"></div>
        <article class="parent-comment" data-comment-id="comment01">
          <div class="content">一级评论</div>
          <div class="reply-container"><div class="comment-item">回复</div></div>
        </article>
      </body></html>
    `);
    const target = inspectNote(
      document as unknown as Document,
      "https://www.xiaohongshu.com/discovery/item/xyz789"
    );
    expect(target.note_type).toBe("image_text");
    expect(findTopLevelCommentNodes(document as unknown as Document)).toHaveLength(1);
  });

  it("handles no comments without inventing nodes", () => {
    const { document } = parseHTML("<html><body><div>暂无评论</div></body></html>");
    expect(findTopLevelCommentNodes(document as unknown as Document)).toEqual([]);
  });

  it("returns more than 50 naturally loaded top-level comments", () => {
    const markup = Array.from(
      { length: 120 },
      (_, index) =>
        `<article class="parent-comment" data-comment-id="comment${String(index).padStart(
          3,
          "0"
        )}"><div class="content">评论 ${index}</div></article>`
    ).join("");
    const { document } = parseHTML(`<html><body>${markup}</body></html>`);
    expect(findTopLevelCommentNodes(document as unknown as Document)).toHaveLength(120);
  });

  it("finds the nearest scrollable ancestor in a note modal", () => {
    const { document } = parseHTML(`
      <html><body>
        <div id="modal">
          <section id="scroller">
            <div class="parent-comment" data-comment-id="comment01"></div>
          </section>
        </div>
      </body></html>
    `);
    const scroller = document.querySelector<HTMLElement>("#scroller")!;
    const comment = document.querySelector<HTMLElement>(".parent-comment")!;
    Object.defineProperty(scroller, "clientHeight", { value: 500 });
    Object.defineProperty(scroller, "scrollHeight", { value: 1600 });
    const found = findScrollableAncestor(
      comment as unknown as HTMLElement,
      (element) => ({
        overflowY: element === (scroller as unknown as HTMLElement) ? "auto" : "visible"
      }) as Pick<CSSStyleDeclaration, "overflowY">
    );
    expect(found).toBe(scroller);
  });

  it("finds visible nested replies and an explicit expand control", () => {
    const { document } = parseHTML(`
      <html><body>
        <article class="parent-comment">
          <div class="content">一级评论</div>
          <button>展开 3 条回复</button>
          <div class="reply-container">
            <div class="comment-item" data-comment-id="reply001">
              <div class="content">回复内容</div>
            </div>
          </div>
        </article>
      </body></html>
    `);
    const root = document.querySelector<HTMLElement>(".parent-comment")!;
    expect(findNestedReplyNodes(root as unknown as HTMLElement)).toHaveLength(1);
    expect(
      findReplyExpandControl(root as unknown as HTMLElement)?.textContent
    ).toBe("展开 3 条回复");
  });

  it.each([
    ["请先登录后查看", "login_required"],
    ["请完成安全验证", "captcha"],
    ["该笔记不存在", "target_unavailable"]
  ])("detects blocking page state: %s", (text, reason) => {
    expect(detectPageProblemText(text)?.reason).toBe(reason);
  });
});
