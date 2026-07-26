/**
 * Phase 6 experience demo.
 *
 * Starts the ExperienceBridge (two real AirShareNodes on loopback + vision +
 * transfer runtime), serves the web client, and prints a URL. Open it, grant
 * camera access, pinch → the object follows your finger → release toward PC-B →
 * it beams across and PC-B's clipboard updates.
 *
 *   npm run experience:demo   (runs ui:build first)
 */

import { startExperience } from "../src/bridge/index.js";

async function main(): Promise<void> {
  const { bridge, url } = await startExperience({
    port: Number(process.env["AIRSHARE_UI_PORT"] ?? 4319),
    logLevel: "info",
    clipboardText: process.env["AIRSHARE_CLIP"] ?? "Hello from PC-A — sent with a pinch ✋→📄→💻",
  });

  console.log(`\n  🎥  Air Share experience running`);
  console.log(`  →  open ${url} in a browser and allow the camera\n`);
  console.log(`  Pinch to grab · release toward PC-B · watch it land in PC-B's clipboard.`);
  console.log(`  Ctrl+C to stop.\n`);

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down…");
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
