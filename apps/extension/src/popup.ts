import {
  isAllowedXhsUrl,
  normalizeCaptureLimit,
  type CaptureLimit
} from "@xhs/shared";

const button = document.querySelector<HTMLButtonElement>("#analyze")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const bar = document.querySelector<HTMLElement>("#bar")!;
const captureLimit = document.querySelector<HTMLSelectElement>("#capture-limit")!;
const BUILD_VERSION = "0.6.0";
let userChangedLimit = false;

async function refresh(): Promise<void> {
  const [[tab], stored] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get("captureLimitPreference")
  ]);
  const supported = Boolean(tab?.url && isAllowedXhsUrl(tab.url));
  const current = await chrome.runtime.sendMessage({ type: "GET_STATUS" }) as {
    state: string;
    message: string;
    capturedCount: number;
    captureLimit: CaptureLimit;
    extensionVersion?: string;
  };
  if (current.extensionVersion !== BUILD_VERSION) {
    status.textContent = "正在重新加载新版扩展，请稍后再次打开扩展…";
    button.disabled = true;
    setTimeout(() => chrome.runtime.reload(), 100);
    return;
  }
  const active = current.state === "connecting" || current.state === "capturing";
  const preferred =
    stored.captureLimitPreference === undefined
      ? 100
      : normalizeCaptureLimit(stored.captureLimitPreference);
  if (!userChangedLimit) {
    captureLimit.value = String(active ? normalizeCaptureLimit(current.captureLimit) : preferred);
  }
  status.textContent = supported ? current.message : "请先打开一篇小红书视频或图文笔记。";
  bar.style.width = `${Math.min(
    100,
    (current.capturedCount / (current.captureLimit ?? 50)) * 100
  )}%`;
  button.disabled = !supported || current.state === "connecting" || current.state === "capturing";
  captureLimit.disabled = active;
  button.textContent = current.state === "capturing" ? `读取中（${current.capturedCount} 条）` : "分析当前目标";
}

captureLimit.addEventListener("change", () => {
  userChangedLimit = true;
  const selected = normalizeCaptureLimit(captureLimit.value);
  captureLimit.value = String(selected);
  void chrome.storage.local.set({ captureLimitPreference: selected });
});

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "正在连接桌面端并创建任务…";
  const limit: CaptureLimit = normalizeCaptureLimit(captureLimit.value);
  await chrome.storage.local.set({ captureLimitPreference: limit });
  const result = await chrome.runtime.sendMessage({
    type: "ANALYZE_CURRENT",
    captureLimit: limit
  });
  if (!result?.ok) status.textContent = result?.error ?? "启动失败";
  await refresh();
});

void refresh();
