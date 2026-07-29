import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    background: path.join(root, "src/background.ts"),
    content: path.join(root, "src/content.ts"),
    observer: path.join(root, "src/observer.ts"),
    popup: path.join(root, "src/popup.ts")
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: true,
  minify: false
});

for (const file of ["manifest.json", "popup.html", "popup.css"]) {
  await cp(path.join(root, "src", file), path.join(dist, file));
}
