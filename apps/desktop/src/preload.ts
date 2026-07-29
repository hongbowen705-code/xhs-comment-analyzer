import { contextBridge, ipcRenderer } from "electron";
import type { TaskListItem, TaskView } from "./task-store.js";
import type { ClassificationImportSummary } from "./classification-importer.js";
import type { GptImportSummary } from "./gpt-workflow.js";
import type { SemanticImportSummary } from "./gpt-workflow.js";
import type {
  ManualRevisionInput,
  ReviewQueueRebuildResult,
  ReviewState
} from "./review-service.js";
import type { StorageStatus } from "./storage-service.js";
import type { CleanupPlan, CleanupResult } from "./retention-service.js";
import type { ConnectionDiagnostics } from "./diagnostics-service.js";

export interface DesktopState {
  connectionCount: number;
  outputRoot: string;
  task: TaskView | null;
}

contextBridge.exposeInMainWorld("xhsDesktop", {
  getState: (): Promise<DesktopState> => ipcRenderer.invoke("get-state"),
  chooseOutput: (): Promise<string> => ipcRenderer.invoke("choose-output"),
  openExistingTask: (): Promise<TaskView | null> => ipcRenderer.invoke("open-existing-task"),
  listTasks: (): Promise<TaskListItem[]> => ipcRenderer.invoke("list-tasks"),
  openTaskPath: (taskDir: string): Promise<TaskView> =>
    ipcRenderer.invoke("open-task-path", taskDir),
  getStorageStatus: (): Promise<StorageStatus> => ipcRenderer.invoke("get-storage-status"),
  getConnectionDiagnostics: (): Promise<ConnectionDiagnostics> =>
    ipcRenderer.invoke("get-connection-diagnostics"),
  getCleanupPlan: (): Promise<CleanupPlan> => ipcRenderer.invoke("get-cleanup-plan"),
  applySafeCleanup: (): Promise<CleanupResult | null> =>
    ipcRenderer.invoke("apply-safe-cleanup"),
  stopTask: (): Promise<boolean> => ipcRenderer.invoke("stop-task"),
  resumeTask: (): Promise<boolean> => ipcRenderer.invoke("resume-task"),
  setPermanentRaw: (permanent: boolean): Promise<TaskView> =>
    ipcRenderer.invoke("set-permanent-raw", permanent),
  openTaskDir: (): Promise<boolean> => ipcRenderer.invoke("open-task-dir"),
  importClassification: (): Promise<ClassificationImportSummary | null> =>
    ipcRenderer.invoke("import-classification"),
  showSemanticUpload: (): Promise<boolean> => ipcRenderer.invoke("show-semantic-upload"),
  importSemanticResult: (): Promise<SemanticImportSummary | null> =>
    ipcRenderer.invoke("import-semantic-result"),
  showGptUpload: (): Promise<boolean> => ipcRenderer.invoke("show-gpt-upload"),
  regenerateAnalysisPackage: (): Promise<boolean> =>
    ipcRenderer.invoke("regenerate-analysis-package"),
  importGptResult: (): Promise<GptImportSummary | null> =>
    ipcRenderer.invoke("import-gpt-result"),
  showGptRepair: (): Promise<boolean> => ipcRenderer.invoke("show-gpt-repair"),
  importGptRepair: (): Promise<GptImportSummary | null> =>
    ipcRenderer.invoke("import-gpt-repair"),
  openReport: (): Promise<boolean> => ipcRenderer.invoke("open-report"),
  regenerateReport: (): Promise<boolean> => ipcRenderer.invoke("regenerate-report"),
  openShareReport: (): Promise<boolean> => ipcRenderer.invoke("open-share-report"),
  getReviewState: (commentId?: string): Promise<ReviewState | null> =>
    ipcRenderer.invoke("get-review-state", commentId),
  rebuildReviewQueue: (): Promise<ReviewQueueRebuildResult | null> =>
    ipcRenderer.invoke("rebuild-review-queue"),
  saveManualReview: (input: ManualRevisionInput): Promise<ReviewState> =>
    ipcRenderer.invoke("save-manual-review", input),
  onState: (listener: (state: DesktopState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on("task-update", wrapped);
    return () => ipcRenderer.removeListener("task-update", wrapped);
  }
});
