import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

await build({
  absWorkingDir: packageRoot,
  entryPoints: [path.join(packageRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(packageRoot, "build", "native-host.cjs"),
  alias: {
    "@xhs/shared": path.join(repoRoot, "packages", "shared", "src", "index.ts")
  },
  tsconfigRaw: { compilerOptions: { target: "ES2022" } }
});

await import("./build-sea.mjs");
