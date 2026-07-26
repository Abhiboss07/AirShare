/**
 * Builds the browser client: bundles web/client.ts with esbuild and vendors the
 * MediaPipe wasm + hand-landmark model into web/vendor (so the app has no CDN
 * dependency at runtime). Run via `npm run ui:build`.
 */

import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const webDir = path.join(root, "web");
const distDir = path.join(webDir, "dist");
const vendorDir = path.join(webDir, "vendor");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

async function main(): Promise<void> {
  await fs.mkdir(distDir, { recursive: true });
  await fs.mkdir(vendorDir, { recursive: true });

  // 1. Bundle the client.
  await build({
    entryPoints: [path.join(webDir, "client.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    sourcemap: true,
    minify: true,
    outfile: path.join(distDir, "client.js"),
    logLevel: "info",
  });

  // 2. Vendor the MediaPipe wasm runtime from node_modules.
  const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  await fs.cp(wasmSrc, vendorDir, { recursive: true });
  console.log(`vendored MediaPipe wasm → ${path.relative(root, vendorDir)}`);

  // 3. Fetch the hand-landmark model once (it is git-ignored, ~7 MB).
  const modelPath = path.join(vendorDir, "hand_landmarker.task");
  if (await exists(modelPath)) {
    console.log("hand_landmarker.task already present");
    return;
  }
  console.log("fetching hand_landmarker.task …");
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(modelPath, Buffer.from(await res.arrayBuffer()));
    console.log(`saved model → ${path.relative(root, modelPath)}`);
  } catch (err) {
    console.warn(
      `\n⚠️  could not download the model (${err instanceof Error ? err.message : String(err)}).` +
        `\n   Download it manually to ${path.relative(root, modelPath)} from:\n   ${MODEL_URL}\n`,
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
