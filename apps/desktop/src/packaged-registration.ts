import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { EXTENSION_ID, NATIVE_HOST_NAME } from "@xhs/shared";

const execFileAsync = promisify(execFile);

export interface PackagedRegistrationResult {
  registered: boolean;
  manifest_path: string;
  host_path: string;
}

export function buildNativeHostManifest(hostPath: string): {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
} {
  return {
    name: NATIVE_HOST_NAME,
    description: "XHS Comment Analyzer Native Host",
    path: path.resolve(hostPath),
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
  };
}

export async function registerPackagedNativeHost(input: {
  userDataDir: string;
  resourcesDir: string;
}): Promise<PackagedRegistrationResult> {
  const hostPath = path.join(
    input.resourcesDir,
    "native-host",
    "xhs-comment-native-host.exe"
  );
  const manifestDir = path.join(input.userDataDir, "native-host");
  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(buildNativeHostManifest(hostPath), null, 2),
    "utf8"
  );
  await execFileAsync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
    [
      "ADD",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f"
    ],
    { windowsHide: true }
  );
  return {
    registered: true,
    manifest_path: manifestPath,
    host_path: hostPath
  };
}
