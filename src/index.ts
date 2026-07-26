/**
 * Air Share — public entrypoint & reference CLI.
 *
 * As a library: import { AirShareNode } and embed it. As a program: `air-share`
 * starts a node, logs lifecycle events, and prompts for pairing approval on
 * first contact with an unknown device (or auto-approves when AIRSHARE_AUTO_PAIR
 * is set — useful for headless test rigs).
 */

import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { AirShareNode } from "./core/airShareNode.js";

export { AirShareNode } from "./core/airShareNode.js";
export type { AirShareNodeOptions } from "./core/airShareNode.js";
export { loadConfig } from "./config/config.js";
export type * from "./config/types.js";
export type * from "./types/device.js";
export type * from "./types/events.js";
export * from "./types/messages.js";
export * from "./types/gestures.js";
export * from "./types/transfer.js";
export * from "./vision/index.js";
export * from "./transfer/index.js";
export * from "./mesh/index.js";
export * from "./content/index.js";

async function main(): Promise<void> {
  const node = new AirShareNode();
  const autoPair = process.env["AIRSHARE_AUTO_PAIR"] === "1";

  node.on("device:found", ({ identity }) =>
    console.log(`🔎 found: ${identity.name} (${identity.id.slice(0, 12)}…)`),
  );
  node.on("device:connected", ({ device }) =>
    console.log(`✅ connected: ${device.identity.name}`),
  );
  node.on("device:disconnected", ({ deviceId, reason }) =>
    console.log(`❌ disconnected: ${deviceId.slice(0, 12)}… (${reason})`),
  );
  node.on("heartbeat:ok", ({ deviceId, rttMs }) =>
    console.log(`💓 ${deviceId.slice(0, 12)}… rtt=${rttMs}ms`),
  );

  node.on("pair:request", ({ device, verificationCode, accept, reject }) => {
    if (autoPair) {
      console.log(`🤝 auto-pairing ${device.identity.name} (code ${verificationCode})`);
      accept();
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `\n🤝 Pair with "${device.identity.name}"? Verify code ${verificationCode} matches. [y/N] `,
      (answer) => {
        rl.close();
        if (answer.trim().toLowerCase().startsWith("y")) accept();
        else reject("declined at prompt");
      },
    );
  });

  await node.start();
  console.log(
    `\nAir Share running as "${node.identityInfo.name}" (${node.identityInfo.id.slice(0, 12)}…) on port ${node.port}.`,
  );
  console.log("Press Ctrl+C to stop.\n");

  const shutdown = async (): Promise<void> => {
    console.log("\nShutting down…");
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Run the CLI only when executed directly, not when imported as a library.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("fatal:", error);
    process.exit(1);
  });
}
