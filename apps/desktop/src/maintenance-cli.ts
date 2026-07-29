import path from "node:path";
import { existsSync } from "node:fs";
import { TaskStore } from "./task-store.js";
import { regenerateReport } from "./review-service.js";
import { generateSemanticAnalysisUpload } from "./gpt-workflow.js";

async function main(): Promise<void> {
  const taskDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!taskDir || !existsSync(path.join(taskDir, "manifest.json"))) {
    throw new Error("用法：node dist/maintenance.cjs <task_任务目录>");
  }
  const store = new TaskStore(path.dirname(taskDir));
  const view = await store.openCompletedTask(taskDir);
  await store.regenerateAnalysisPackage();
  let semanticUploadGenerated = false;
  if (
    existsSync(
      path.join(taskDir, "ai_results", "classification-merged.jsonl")
    )
  ) {
    await generateSemanticAnalysisUpload(taskDir);
    semanticUploadGenerated = true;
  }
  let reportRegenerated = false;
  if (
    existsSync(path.join(taskDir, "ai_results", "analysis_result.json")) &&
    existsSync(path.join(taskDir, "ai_results", "classification-merged.jsonl"))
  ) {
    await regenerateReport(taskDir);
    reportRegenerated = true;
  }
  process.stdout.write(
    `${JSON.stringify({
      task_id: view.taskId,
      package_regenerated: true,
      semantic_upload_generated: semanticUploadGenerated,
      report_regenerated: reportRegenerated
    })}\n`
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
