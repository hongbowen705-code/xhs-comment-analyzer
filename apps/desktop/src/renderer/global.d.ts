import type { DesktopState } from "../preload";
import type { ClassificationImportSummary } from "../classification-importer";
import type { GptImportSummary } from "../gpt-workflow";
import type { SemanticImportSummary } from "../gpt-workflow";
import type {
  ManualRevisionInput,
  ReviewQueueRebuildResult,
  ReviewState
} from "../review-service";
import type { TaskListItem, TaskView } from "../task-store";
import type { StorageStatus } from "../storage-service";
import type { CleanupPlan, CleanupResult } from "../retention-service";
import type { ConnectionDiagnostics } from "../diagnostics-service";

declare global {
  interface Window {
    xhsDesktop: {
      getState(): Promise<DesktopState>;
      chooseOutput(): Promise<string>;
      openExistingTask(): Promise<import("../task-store").TaskView | null>;
      listTasks(): Promise<TaskListItem[]>;
      openTaskPath(taskDir: string): Promise<TaskView>;
      getStorageStatus(): Promise<StorageStatus>;
      getConnectionDiagnostics(): Promise<ConnectionDiagnostics>;
      getCleanupPlan(): Promise<CleanupPlan>;
      applySafeCleanup(): Promise<CleanupResult | null>;
      stopTask(): Promise<boolean>;
      resumeTask(): Promise<boolean>;
      setPermanentRaw(permanent: boolean): Promise<TaskView>;
      openTaskDir(): Promise<boolean>;
      importClassification(): Promise<ClassificationImportSummary | null>;
      showSemanticUpload(): Promise<boolean>;
      importSemanticResult(): Promise<SemanticImportSummary | null>;
      showGptUpload(): Promise<boolean>;
      regenerateAnalysisPackage(): Promise<boolean>;
      importGptResult(): Promise<GptImportSummary | null>;
      showGptRepair(): Promise<boolean>;
      importGptRepair(): Promise<GptImportSummary | null>;
      openReport(): Promise<boolean>;
      regenerateReport(): Promise<boolean>;
      openShareReport(): Promise<boolean>;
      getReviewState(commentId?: string): Promise<ReviewState | null>;
      rebuildReviewQueue(): Promise<ReviewQueueRebuildResult | null>;
      saveManualReview(input: ManualRevisionInput): Promise<ReviewState>;
      onState(listener: (state: DesktopState) => void): () => void;
    };
  }
}

export {};
