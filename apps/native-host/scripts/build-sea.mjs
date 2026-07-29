import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(packageRoot, "build");
const distDir = path.join(packageRoot, "dist");
const configPath = path.join(buildDir, "sea-config.json");
const outputPath = path.join(distDir, "xhs-comment-native-host.exe");

await mkdir(distDir, { recursive: true });
await writeFile(
  configPath,
  JSON.stringify({
    main: path.join(buildDir, "native-host.cjs"),
    output: outputPath,
    disableExperimentalSEAWarning: true
  }, null, 2),
  "utf8"
);

execFileSync(process.execPath, ["--build-sea", configPath], {
  cwd: packageRoot,
  stdio: "inherit"
});
