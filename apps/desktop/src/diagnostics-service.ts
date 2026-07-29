import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@xhs/shared";

const execFileAsync = promisify(execFile);

export interface ConnectionDiagnostics {
  checked_at: string;
  status: "healthy" | "warning" | "error";
  chrome_found: boolean;
  registry_entry_found: boolean;
  manifest_found: boolean;
  host_executable_found: boolean;
  allowed_origin_correct: boolean;
  expected_host_matches: boolean | null;
  registered_manifest_path: string | null;
  registered_host_path: string | null;
  issue_codes: string[];
}

export async function collectConnectionDiagnostics(
  expectedHostPath?: string
): Promise<ConnectionDiagnostics> {
  const chromeFound = chromeCandidates().some((candidate) =>
    existsSync(candidate)
  );
  const manifestPath = await readRegisteredManifestPath();
  let manifest: Record<string, any> | null = null;
  if (manifestPath && existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
  }
  return analyzeDiagnosticSnapshot({
    chromeFound,
    manifestPath,
    manifest,
    expectedHostPath
  });
}

export function analyzeDiagnosticSnapshot(input: {
  chromeFound: boolean;
  manifestPath: string | null;
  manifest: Record<string, any> | null;
  expectedHostPath?: string;
}): ConnectionDiagnostics {
  const hostPath =
    typeof input.manifest?.path === "string" ? input.manifest.path : null;
  const hostFound = Boolean(hostPath && existsSync(hostPath));
  const originCorrect = Boolean(
    Array.isArray(input.manifest?.allowed_origins) &&
      input.manifest.allowed_origins.includes(
        `chrome-extension://${EXTENSION_ID}/`
      )
  );
  const expectedMatches =
    input.expectedHostPath && hostPath
      ? path.resolve(input.expectedHostPath).toLocaleLowerCase() ===
        path.resolve(hostPath).toLocaleLowerCase()
      : input.expectedHostPath
        ? false
        : null;
  const issues: string[] = [];
  if (!input.chromeFound) issues.push("chrome_not_found");
  if (!input.manifestPath) issues.push("registry_entry_missing");
  else if (!input.manifest) issues.push("manifest_missing_or_invalid");
  if (input.manifest && !hostFound) issues.push("host_executable_missing");
  if (input.manifest && !originCorrect) issues.push("extension_origin_mismatch");
  if (expectedMatches === false) issues.push("different_version_registered");
  return {
    checked_at: new Date().toISOString(),
    status: issues.some((code) =>
      [
        "registry_entry_missing",
        "manifest_missing_or_invalid",
        "host_executable_missing",
        "extension_origin_mismatch"
      ].includes(code)
    )
      ? "error"
      : issues.length
        ? "warning"
        : "healthy",
    chrome_found: input.chromeFound,
    registry_entry_found: Boolean(input.manifestPath),
    manifest_found: Boolean(input.manifest),
    host_executable_found: hostFound,
    allowed_origin_correct: originCorrect,
    expected_host_matches: expectedMatches,
    registered_manifest_path: input.manifestPath,
    registered_host_path: hostPath,
    issue_codes: issues
  };
}

async function readRegisteredManifestPath(): Promise<string | null> {
  const registryPath = `HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  const command = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
    `$p='${registryPath}';`,
    "if(Test-Path -LiteralPath $p){[Console]::Write((Get-Item -LiteralPath $p).GetValue(''))}"
  ].join("");
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", command],
      { windowsHide: true, encoding: "utf8" }
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function chromeCandidates(): string[] {
  return [
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    ),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    ),
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    )
  ];
}
