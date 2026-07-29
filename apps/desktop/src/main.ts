import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import net from "node:net";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  PIPE_NAME,
  captureModeForLimit,
  createEnvelope,
  isAllowedXhsUrl,
  isEnvelope,
  normalizeCaptureLimit,
  type AuditPayload,
  type CaptureEndPayload,
  type CommentBatchPayload,
  type CreateTaskPayload,
  type Envelope,
  type NoteTarget
} from "@xhs/shared";
import {
  TaskStore,
  isWritableDirectory,
  type TaskListItem,
  type TaskView
} from "./task-store.js";
import {
  importClassificationFiles,
  type ClassificationImportSummary
} from "./classification-importer.js";
import {
  importGptRepairResult,
  importGptResult,
  generateSemanticAnalysisUpload,
  importSemanticAnalysisResult,
  type SemanticImportSummary,
  type GptImportSummary
} from "./gpt-workflow.js";
import {
  applyManualRevision,
  getReviewState,
  rebuildReviewQueue,
  regenerateReport,
  type ManualRevisionInput,
  type ReviewQueueRebuildResult,
  type ReviewState
} from "./review-service.js";
import { getStorageStatus, type StorageStatus } from "./storage-service.js";
import {
  applySafeCleanup,
  createCleanupPlan,
  type CleanupPlan,
  type CleanupResult
} from "./retention-service.js";
import { registerPackagedNativeHost } from "./packaged-registration.js";
import {
  collectConnectionDiagnostics,
  type ConnectionDiagnostics
} from "./diagnostics-service.js";

const defaultOutput = "D:\\XHSCommentAnalyzer\\prototype";
let mainWindow: BrowserWindow | null = null;
let pipeServer: net.Server | null = null;
const extensionSockets = new Set<net.Socket>();
const store = new TaskStore(defaultOutput);

async function rememberTask(taskDir: string): Promise<void> {
  const settingsDir = app.getPath("userData");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "last-task.json"),
    JSON.stringify({ schema_version: "1.0", task_dir: taskDir }, null, 2),
    "utf8"
  );
}

async function restoreLastTask(): Promise<void> {
  try {
    const saved = JSON.parse(
      await readFile(path.join(app.getPath("userData"), "last-task.json"), "utf8")
    ) as { task_dir?: string };
    if (
      saved.task_dir &&
      existsSync(path.join(saved.task_dir, "manifest.json"))
    ) {
      await store.openCompletedTask(saved.task_dir);
    }
  } catch {
    // First launch or a removed task is a normal idle state.
  }
}

function publishState(): void {
  mainWindow?.webContents.send("task-update", {
    connectionCount: extensionSockets.size,
    outputRoot: store.getOutputRoot(),
    task: store.getView()
  });
}

async function handleEnvelope(envelope: Envelope, socket: net.Socket): Promise<void> {
  try {
    if (envelope.message_type === "capability_check") {
      sendLine(socket, createEnvelope("capability_check", {
        desktop_ready: true,
        output_writable: await isWritableDirectory(store.getOutputRoot()),
        single_task: true
      }, null, envelope.request_id));
      return;
    }
    if (envelope.message_type === "create_task") {
      const incoming = envelope.payload as Partial<CreateTaskPayload> & Partial<NoteTarget>;
      const target = (incoming.target ?? incoming) as NoteTarget;
      const captureLimit = normalizeCaptureLimit(incoming.capture_limit);
      const captureMode = captureModeForLimit(captureLimit);
      if (!target || !isAllowedXhsUrl(target.normalized_url)) {
        throw new Error("目标不是受支持的小红书笔记链接");
      }
      if (!(await isWritableDirectory(store.getOutputRoot()))) {
        throw new Error("输出目录不可写，请先在桌面端选择目录");
      }
      const storageStatus = await getStorageStatus(store.getOutputRoot());
      if (storageStatus.level === "blocked") {
        throw new Error("数据占用已达到 5.8GB 安全暂停线，请先在桌面端清理或更换输出目录");
      }
      const view = await store.createTask(target, captureLimit, captureMode);
      await rememberTask(view.taskDir);
      sendLine(socket, createEnvelope("task_created", {
        task_id: view.taskId,
        capture_limit: view.captureLimit,
        capture_token: crypto.randomUUID()
      }, view.taskId, envelope.request_id));
      publishState();
      return;
    }
    if (!envelope.task_id || envelope.task_id !== store.getView()?.taskId) {
      throw new Error("任务 ID 无效或已过期");
    }
    if (envelope.message_type === "comment_batch") {
      await store.acceptBatch(envelope.payload as CommentBatchPayload);
      publishState();
      return;
    }
    if (envelope.message_type === "audit_event") {
      const audit = envelope.payload as AuditPayload;
      if (audit.platform_write_count !== 0) throw new Error("检测到非法写入审计值");
      await store.appendAudit(audit);
      return;
    }
    if (envelope.message_type === "progress") {
      publishState();
      return;
    }
    if (envelope.message_type === "capture_completed" || envelope.message_type === "capture_paused") {
      await store.finish(
        envelope.payload as CaptureEndPayload,
        envelope.message_type === "capture_paused"
      );
      publishState();
    }
  } catch (error) {
    sendLine(socket, createEnvelope("error", {
      code: "DESKTOP_REJECTED_MESSAGE",
      message: error instanceof Error ? error.message : "未知桌面端错误",
      recoverable: true
    }, envelope.task_id, envelope.request_id));
  }
}

function sendLine(socket: net.Socket, envelope: Envelope): void {
  socket.write(`${JSON.stringify(envelope)}\n`);
}

function startPipeServer(): void {
  pipeServer = net.createServer((socket) => {
    extensionSockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let processing = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            if (!isEnvelope(parsed)) throw new Error("无效消息信封");
            processing = processing.then(() => handleEnvelope(parsed, socket));
          } catch (error) {
            sendLine(socket, createEnvelope("error", {
              code: "INVALID_PIPE_MESSAGE",
              message: error instanceof Error ? error.message : "消息解析失败",
              recoverable: false
            }));
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      extensionSockets.delete(socket);
      if (extensionSockets.size === 0 && store.getView()?.phase === "capturing") {
        void store.finish({
          reason: "extension_disconnected",
          captured_count: store.getView()?.capturedCount ?? 0
        }, true).then(publishState);
      }
      publishState();
    });
    socket.on("error", () => {
      extensionSockets.delete(socket);
      publishState();
    });
    publishState();
  });
  pipeServer.on("error", (error: NodeJS.ErrnoException) => {
    dialog.showErrorBox("本地通信启动失败", error.code === "EADDRINUSE" ? "已有桌面实例正在运行。" : error.message);
  });
  pipeServer.listen(PIPE_NAME);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 760,
    minHeight: 580,
    title: "小红书评论分析工具 - 技术原型",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", publishState);
}

ipcMain.handle("get-state", () => ({
  connectionCount: extensionSockets.size,
  outputRoot: store.getOutputRoot(),
  task: store.getView()
}));

ipcMain.handle("choose-output", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (!result.canceled && result.filePaths[0]) {
    store.setOutputRoot(result.filePaths[0]);
    publishState();
  }
  return store.getOutputRoot();
});

ipcMain.handle("open-existing-task", async (): Promise<TaskView | null> => {
  const result = await dialog.showOpenDialog({
    title: "选择 task_<task_id> 任务目录",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const view = await store.openCompletedTask(result.filePaths[0]);
  await rememberTask(view.taskDir);
  publishState();
  return view;
});

ipcMain.handle("list-tasks", (): Promise<TaskListItem[]> => store.listTasks());

ipcMain.handle("open-task-path", async (_event, taskDir: string): Promise<TaskView> => {
  const known = (await store.listTasks()).some((task) => task.taskDir === taskDir);
  if (!known) throw new Error("任务目录不在当前数据根目录中");
  const view = await store.openCompletedTask(taskDir);
  await rememberTask(view.taskDir);
  publishState();
  return view;
});

ipcMain.handle("get-storage-status", (): Promise<StorageStatus> =>
  getStorageStatus(store.getOutputRoot())
);

ipcMain.handle("get-connection-diagnostics", (): Promise<ConnectionDiagnostics> =>
  collectConnectionDiagnostics(
    app.isPackaged
      ? path.join(
          process.resourcesPath,
          "native-host",
          "xhs-comment-native-host.exe"
        )
      : path.resolve(
          __dirname,
          "..",
          "..",
          "native-host",
          "dist",
          "xhs-comment-native-host.exe"
        )
  )
);

ipcMain.handle("get-cleanup-plan", (): Promise<CleanupPlan> =>
  createCleanupPlan(store.getOutputRoot())
);

ipcMain.handle("apply-safe-cleanup", async (): Promise<CleanupResult | null> => {
  const plan = await createCleanupPlan(store.getOutputRoot());
  if (plan.safe_reclaim_bytes === 0) {
    return { removed_count: 0, reclaimed_bytes: 0, failed: [] };
  }
  const confirmation = await dialog.showMessageBox({
    type: "warning",
    buttons: ["取消", "清理缓存和过期日志"],
    defaultId: 0,
    cancelId: 0,
    title: "确认安全清理",
    message: `将删除 ${plan.candidates.filter((item) => item.safe_to_auto_remove).length} 个缓存或过期日志文件。`,
    detail: "不会删除评论原文、分析结果或任何报告。此操作无法撤销。"
  });
  if (confirmation.response !== 1) return null;
  return applySafeCleanup(plan);
});

ipcMain.handle("stop-task", () => {
  const task = store.getView();
  if (!task || task.phase !== "capturing") return false;
  const message = createEnvelope("stop_capture", { reason: "user_stopped" }, task.taskId);
  for (const socket of extensionSockets) sendLine(socket, message);
  return true;
});

ipcMain.handle("resume-task", async (): Promise<boolean> => {
  if (extensionSockets.size === 0) {
    throw new Error("扩展尚未连接。请先打开 Chrome，并确认扩展已启用。");
  }
  const resume = await store.prepareResume();
  const message = createEnvelope("start_capture", {
    url: resume.url,
    capture_limit: resume.captureLimit,
    initial_count: resume.initialCount,
    capture_token: resume.captureToken,
    existing_platform_ids: resume.existingPlatformIds,
    existing_content_keys: resume.existingContentKeys
  }, resume.taskId);
  for (const socket of extensionSockets) sendLine(socket, message);
  publishState();
  return true;
});

ipcMain.handle("set-permanent-raw", async (_event, permanent: boolean): Promise<TaskView> => {
  const view = await store.setPermanentRaw(Boolean(permanent));
  publishState();
  return view;
});

ipcMain.handle("open-task-dir", async () => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir || !existsSync(taskDir)) return false;
  return (await shell.openPath(taskDir)) === "";
});

ipcMain.handle("import-classification", async (): Promise<ClassificationImportSummary | null> => {
  const task = store.getView();
  if (!task || task.phase === "capturing") return null;
  const result = await dialog.showOpenDialog({
    title: "选择 GPT 返回的逐条分类 JSONL",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "GPT batch JSON / JSON Lines", extensions: ["json", "jsonl", "txt"] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const summary = await importClassificationFiles(task.taskDir, result.filePaths);
  if (summary.status === "accepted") {
    await generateSemanticAnalysisUpload(task.taskDir);
  }
  return summary;
});

ipcMain.handle("show-gpt-upload", (): boolean => {
  const task = store.getView();
  if (!task || task.phase === "capturing") return false;
  const uploadPath = path.join(task.taskDir, "gpt_upload.json");
  if (!existsSync(uploadPath)) return false;
  shell.showItemInFolder(uploadPath);
  return true;
});

ipcMain.handle("regenerate-analysis-package", async (): Promise<boolean> => {
  const task = store.getView();
  if (!task || task.phase === "capturing") return false;
  await store.regenerateAnalysisPackage();
  if (
    existsSync(path.join(task.taskDir, "ai_results", "classification-merged.jsonl"))
  ) {
    await generateSemanticAnalysisUpload(task.taskDir);
  }
  publishState();
  return true;
});

ipcMain.handle("show-semantic-upload", (): boolean => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir) return false;
  const uploadPath = path.join(taskDir, "gpt_analysis_upload.json");
  if (!existsSync(uploadPath)) return false;
  shell.showItemInFolder(uploadPath);
  return true;
});

ipcMain.handle("import-semantic-result", async (): Promise<SemanticImportSummary | null> => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir) return null;
  const result = await dialog.showOpenDialog({
    title: "选择 ChatGPT 返回的总体语义分析 JSON",
    properties: ["openFile"],
    filters: [{ name: "Semantic Analysis JSON", extensions: ["json", "txt"] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return importSemanticAnalysisResult(taskDir, result.filePaths[0]);
});

ipcMain.handle("import-gpt-result", async (): Promise<GptImportSummary | null> => {
  const task = store.getView();
  if (!task || task.phase === "capturing") return null;
  const result = await dialog.showOpenDialog({
    title: "选择 ChatGPT 返回的 gpt_result.json",
    properties: ["openFile"],
    filters: [{ name: "GPT Result JSON", extensions: ["json", "txt"] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return importGptResult(task.taskDir, result.filePaths[0]);
});

ipcMain.handle("show-gpt-repair", (): boolean => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir) return false;
  const repairPath = path.join(taskDir, "gpt_repair_request.json");
  if (!existsSync(repairPath)) return false;
  shell.showItemInFolder(repairPath);
  return true;
});

ipcMain.handle("import-gpt-repair", async (): Promise<GptImportSummary | null> => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir) return null;
  const result = await dialog.showOpenDialog({
    title: "选择GPT返回的局部修复JSON",
    properties: ["openFile"],
    filters: [{ name: "GPT Repair JSON", extensions: ["json", "txt"] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return importGptRepairResult(taskDir, result.filePaths[0]);
});

ipcMain.handle("open-report", async (): Promise<boolean> => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir) return false;
  const reportPath = path.join(taskDir, "report_private", "index.html");
  if (!existsSync(reportPath)) return false;
  return (await shell.openPath(reportPath)) === "";
});

ipcMain.handle("regenerate-report", async (): Promise<boolean> => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir || !existsSync(path.join(taskDir, "ai_results", "analysis_result.json"))) {
    return false;
  }
  await regenerateReport(taskDir);
  publishState();
  return true;
});

ipcMain.handle("open-share-report", async (): Promise<boolean> => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir) return false;
  const reportPath = path.join(taskDir, "report_share.html");
  if (!existsSync(reportPath)) return false;
  return (await shell.openPath(reportPath)) === "";
});

ipcMain.handle("get-review-state", async (_event, commentId?: string): Promise<ReviewState | null> => {
  const taskDir = store.getView()?.taskDir;
  if (!taskDir || !existsSync(path.join(taskDir, "ai_results", "review-queue.json"))) {
    return null;
  }
  return getReviewState(taskDir, commentId);
});

ipcMain.handle(
  "rebuild-review-queue",
  async (): Promise<ReviewQueueRebuildResult | null> => {
    const taskDir = store.getView()?.taskDir;
    if (
      !taskDir ||
      !existsSync(path.join(taskDir, "ai_results", "review-queue.json"))
    ) {
      return null;
    }
    const current = await getReviewState(taskDir);
    const confirmation = await dialog.showMessageBox({
      type: "question",
      buttons: ["取消", "应用精简审核规则"],
      defaultId: 0,
      cancelId: 0,
      title: "精简人工复核队列",
      message: `当前还有 ${current.pending_count} 条待复核评论。`,
      detail:
        "将按更严格的本地风险阈值重新筛选。已完成的人工复核会保留，原队列会先备份，不会删除评论、AI结果、人工修改记录或报告。"
    });
    if (confirmation.response !== 1) return null;
    const result = await rebuildReviewQueue(taskDir);
    publishState();
    return result;
  }
);

ipcMain.handle(
  "save-manual-review",
  async (_event, input: ManualRevisionInput): Promise<ReviewState> => {
    const taskDir = store.getView()?.taskDir;
    if (!taskDir) throw new Error("当前没有已打开的任务");
    return applyManualRevision(taskDir, input);
  }
);

app.whenReady().then(async () => {
  if (app.isPackaged) {
    try {
      await registerPackagedNativeHost({
        userDataDir: app.getPath("userData"),
        resourcesDir: process.resourcesPath
      });
    } catch (error) {
      dialog.showErrorBox(
        "浏览器连接注册失败",
        `桌面端可以继续启动，但 Chrome 扩展暂时无法连接。请运行安装目录中的诊断工具。\n\n${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  await restoreLastTask();
  startPipeServer();
  createWindow();
});

app.on("window-all-closed", () => {
  pipeServer?.close();
  if (process.platform !== "darwin") app.quit();
});
