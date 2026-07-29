import {
  NATIVE_HOST_NAME,
  captureModeForLimit,
  createEnvelope,
  isAllowedXhsUrl,
  isEnvelope,
  normalizeCaptureLimit,
  normalizeXhsUrl,
  type CaptureEndPayload,
  type Envelope,
  type NoteTarget,
  type CaptureLimit
} from "@xhs/shared";

interface ActiveSession {
  taskId: string;
  tabId: number;
  captureToken: string;
  captureLimit: CaptureLimit;
  initialCount: number;
  existingPlatformIds: string[];
  existingContentKeys: string[];
  started: boolean;
}

interface PopupStatus {
  state: "idle" | "connecting" | "capturing" | "completed" | "error";
  message: string;
  capturedCount: number;
  captureLimit: CaptureLimit;
}

let nativePort: chrome.runtime.Port | null = null;
let activeSession: ActiveSession | null = null;
let popupStatus: PopupStatus = {
  state: "idle",
  message: "等待选择目标",
  capturedCount: 0,
  captureLimit: 100
};
const pending = new Map<string, (message: Envelope) => void>();
const BUILD_VERSION = "0.6.0";

function setStatus(
  status: Omit<PopupStatus, "captureLimit"> &
    Partial<Pick<PopupStatus, "captureLimit">>
): void {
  popupStatus = { ...popupStatus, ...status };
  void chrome.storage.local.set({ popupStatus });
}

function connectNative(): chrome.runtime.Port {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener((message: unknown) => {
    if (!isEnvelope(message)) {
      setStatus({ state: "error", message: "Native Host 返回了无效消息", capturedCount: popupStatus.capturedCount });
      return;
    }
    const resolve = pending.get(message.request_id);
    if (resolve) {
      pending.delete(message.request_id);
      resolve(message);
    }
    void handleNativeMessage(message);
  });
  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message ?? "Native Host 已断开";
    nativePort = null;
    setStatus({ state: "error", message: detail, capturedCount: popupStatus.capturedCount });
    if (activeSession) {
      void chrome.tabs.sendMessage(activeSession.tabId, { type: "STOP_CAPTURE", reason: "extension_disconnected" }).catch(() => undefined);
    }
  });
  return port;
}

async function requestNative(envelope: Envelope, timeoutMs = 5000): Promise<Envelope> {
  const port = connectNative();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(envelope.request_id);
      reject(new Error("桌面端响应超时"));
    }, timeoutMs);
    pending.set(envelope.request_id, (message) => {
      clearTimeout(timeout);
      if (message.message_type === "error") {
        const payload = message.payload as { message?: string };
        reject(new Error(payload.message ?? "桌面端拒绝请求"));
      } else {
        resolve(message);
      }
    });
    port.postMessage(envelope);
  });
}

async function handleNativeMessage(message: Envelope): Promise<void> {
  if (message.message_type === "start_capture") {
    if (activeSession) {
      connectNative().postMessage(createEnvelope("error", {
        code: "ACTIVE_CAPTURE_EXISTS",
        message: "已有采集任务，不能同时恢复另一个任务。",
        recoverable: true
      }, message.task_id, message.request_id));
      return;
    }
    const payload = message.payload as {
      url?: string;
      capture_limit?: number;
      initial_count?: number;
      capture_token?: string;
      existing_platform_ids?: unknown[];
      existing_content_keys?: unknown[];
    };
    if (
      !message.task_id ||
      !payload.url ||
      !isAllowedXhsUrl(payload.url) ||
      typeof payload.capture_token !== "string"
    ) {
      connectNative().postMessage(createEnvelope("error", {
        code: "INVALID_RESUME_REQUEST",
        message: "恢复任务参数无效。",
        recoverable: false
      }, message.task_id, message.request_id));
      return;
    }
    const existingTabs = await chrome.tabs.query({});
    const matchingTab = existingTabs.find(
      (candidate) =>
        candidate.id &&
        candidate.url &&
        isAllowedXhsUrl(candidate.url) &&
        normalizeXhsUrl(candidate.url) === normalizeXhsUrl(payload.url!)
    );
    const tab = matchingTab?.id
      ? await chrome.tabs.duplicate(matchingTab.id)
      : await chrome.tabs.create({ url: payload.url, active: true });
    if (!tab?.id) throw new Error("无法创建恢复采集标签页");
    await chrome.tabs.update(tab.id, { active: true });
    const initialCount = Math.max(0, Math.floor(Number(payload.initial_count) || 0));
    activeSession = {
      taskId: message.task_id,
      tabId: tab.id,
      captureToken: payload.capture_token,
      captureLimit: normalizeCaptureLimit(payload.capture_limit),
      initialCount,
      existingPlatformIds: (payload.existing_platform_ids ?? [])
        .filter((value): value is string => typeof value === "string")
        .slice(0, 3000),
      existingContentKeys: (payload.existing_content_keys ?? [])
        .filter((value): value is string => typeof value === "string")
        .slice(0, 3000),
      started: false
    };
    setStatus({
      state: "connecting",
      message: "正在打开专用标签页并恢复读取…",
      capturedCount: initialCount,
      captureLimit: activeSession.captureLimit
    });
    if (tab.status === "complete") await startCaptureInTab(activeSession);
    return;
  }
  if (message.message_type === "stop_capture" && activeSession && message.task_id === activeSession.taskId) {
    await chrome.tabs.sendMessage(activeSession.tabId, {
      type: "STOP_CAPTURE",
      reason: "user_stopped"
    }).catch(() => undefined);
  }
  if (message.message_type === "error") {
    const payload = message.payload as { message?: string };
    setStatus({ state: "error", message: payload.message ?? "本地服务错误", capturedCount: popupStatus.capturedCount });
  }
}

async function analyzeCurrentTarget(requestedLimit: CaptureLimit): Promise<void> {
  setStatus({
    state: "connecting",
    message: "正在识别当前笔记…",
    capturedCount: 0,
    captureLimit: requestedLimit
  });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isAllowedXhsUrl(tab.url)) {
    throw new Error("当前标签页不是受支持的小红书笔记");
  }
  const detected = await sendToTabWithRecovery<{
    ok: boolean;
    target?: NoteTarget;
    error?: string;
  }>(tab.id, { type: "DETECT_TARGET" });
  if (!detected.ok || !detected.target) throw new Error(detected.error ?? "无法识别目标");
  const captureMode = captureModeForLimit(requestedLimit);
  const created = await requestNative(createEnvelope("create_task", {
    target: detected.target,
    capture_mode: captureMode,
    capture_limit: requestedLimit
  }));
  const payload = created.payload as {
    task_id: string;
    capture_limit: number;
    capture_token: string;
  };
  // Duplicate the already-readable tab so transient XHS navigation context stays
  // in browser memory. The normalized URL sent to desktop remains query-free.
  const dedicated = await chrome.tabs.duplicate(tab.id);
  if (!dedicated?.id) throw new Error("无法创建专用分析标签页");
  await chrome.tabs.update(dedicated.id, { active: true });
  activeSession = {
    taskId: payload.task_id,
    tabId: dedicated.id,
    captureToken: payload.capture_token,
    captureLimit: normalizeCaptureLimit(payload.capture_limit),
    initialCount: 0,
    existingPlatformIds: [],
    existingContentKeys: [],
    started: false
  };
  setStatus({
    state: "connecting",
    message: "等待专用标签页加载…",
    capturedCount: 0,
    captureLimit: activeSession.captureLimit
  });
  if (dedicated.status === "complete") {
    await startCaptureInTab(activeSession);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete" || tabId !== activeSession?.tabId) return;
  void startCaptureInTab(activeSession);
});

async function startCaptureInTab(session: ActiveSession): Promise<void> {
  if (session.started || activeSession !== session) return;
  session.started = true;
  try {
    await sendToTabWithRecovery(session.tabId, {
    type: "START_CAPTURE",
    taskId: session.taskId,
    captureToken: session.captureToken,
    limit: session.captureLimit,
    initialCount: session.initialCount,
    existingPlatformIds: session.existingPlatformIds,
    existingContentKeys: session.existingContentKeys
    });
    setStatus({
      state: "capturing",
      message: `正在可见读取评论（上限 ${session.captureLimit} 条）`,
      capturedCount: session.initialCount,
      captureLimit: session.captureLimit
    });
  } catch (error) {
    session.started = false;
    setStatus({ state: "error", message: String(error), capturedCount: 0 });
  }
}

async function sendToTabWithRecovery<T = unknown>(
  tabId: number,
  message: unknown
): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message) as T;
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !isAllowedXhsUrl(tab.url)) {
      throw new Error("只允许在受支持的小红书笔记页恢复采集脚本");
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["observer.js"],
      world: "MAIN"
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
      world: "ISOLATED"
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await chrome.tabs.sendMessage(tabId, message) as T;
  }
}

function isMissingReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Could not establish connection") ||
    message.includes("Receiving end does not exist")
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activeSession?.tabId) return;
  const session = activeSession;
  activeSession = null;
  const end: CaptureEndPayload = { reason: "tab_closed", captured_count: popupStatus.capturedCount };
  nativePort?.postMessage(createEnvelope("capture_paused", end, session.taskId));
  setStatus({ state: "error", message: "专用标签页已关闭，任务已暂停", capturedCount: popupStatus.capturedCount });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ANALYZE_CURRENT") {
    const requestedLimit = normalizeCaptureLimit(message.captureLimit);
    void analyzeCurrentTarget(requestedLimit)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const text = error instanceof Error ? error.message : "启动失败";
        setStatus({ state: "error", message: text, capturedCount: 0 });
        sendResponse({ ok: false, error: text });
      });
    return true;
  }
  if (message?.type === "GET_STATUS") {
    sendResponse({ ...popupStatus, extensionVersion: BUILD_VERSION });
    return false;
  }
  if (message?.type === "CAPTURE_ENVELOPE" && isEnvelope(message.envelope)) {
    const envelope = message.envelope as Envelope;
    if (!activeSession || envelope.task_id !== activeSession.taskId) {
      sendResponse({ ok: false, error: "任务不匹配" });
      return false;
    }
    if (envelope.message_type === "progress") {
      const payload = envelope.payload as { captured_count: number };
      setStatus({
        state: "capturing",
        message: `正在可见读取评论（上限 ${activeSession.captureLimit} 条）`,
        capturedCount: payload.captured_count
      });
    }
    if (envelope.message_type === "capture_completed" || envelope.message_type === "capture_paused") {
      const payload = envelope.payload as CaptureEndPayload;
      setStatus({
        state: envelope.message_type === "capture_completed" ? "completed" : "error",
        message: `读取结束：${payload.reason}`,
        capturedCount: payload.captured_count
      });
      activeSession = null;
    }
    connectNative().postMessage(envelope);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
