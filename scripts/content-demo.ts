/**
 * Content-transfer demo (Phase 5B).
 *
 * Two real AirShareNodes on loopback. A gesture on PC-A grabs text and drops it
 * onto PC-B, whose clipboard sink writes it to the *real* system clipboard
 * (auto-detected wl-clipboard/xclip; falls back to in-memory with a note). After
 * it runs, paste (Ctrl+V) to see PC-A's text on "PC-B".
 *
 *   npm run content:demo
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { AirShareNode } from "../src/core/airShareNode.js";
import { attachTransferMesh } from "../src/mesh/index.js";
import { StaticTargetResolver } from "../src/transfer/index.js";
import {
  ExecCommandRunner,
  detectClipboardBackend,
  textProvider,
  clipboardSink,
  InMemoryClipboardBackend,
} from "../src/content/index.js";
import { createLogger } from "../src/utils/logger.js";

async function tmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), "air-share-content-demo", randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeNode(name: string, dataDir: string): AirShareNode {
  return new AirShareNode({
    enableDiscovery: false,
    config: {
      deviceName: name,
      dataDir,
      logLevel: "silent",
      network: { port: 0 },
      security: { requirePairingApproval: false },
    },
  });
}

function once<T>(node: AirShareNode, event: Parameters<AirShareNode["on"]>[0]): Promise<T> {
  return new Promise((resolve) => {
    const off = node.on(event, (p) => {
      off();
      resolve(p as T);
    });
  });
}

async function main(): Promise<void> {
  const logger = createLogger("content-demo", "info");
  const dirA = await tmp();
  const dirB = await tmp();
  const a = makeNode("PC-A", dirA);
  const b = makeNode("PC-B", dirB);
  await a.start();
  await b.start();

  // PC-B writes to the real clipboard if a native tool is available.
  const clipB = await detectClipboardBackend(new ExecCommandRunner(), logger);
  const real = !(clipB instanceof InMemoryClipboardBackend);
  const message = "Hello from PC-A — paste me!";

  const aSys = attachTransferMesh(a, {
    supports: ["transfer", "text", "clipboard"],
    providers: [textProvider(() => message)],
    targetResolver: new StaticTargetResolver(b.identityInfo.id),
  });
  attachTransferMesh(b, { supports: ["transfer", "clipboard"], sinks: [clipboardSink(clipB)] });

  const connected = Promise.all([once(a, "device:connected"), once(b, "device:connected")]);
  a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
  await connected;
  console.log("🔗 secure mesh established (handshake + AES-256-GCM session)");

  console.log("\n--- gesture on PC-A: pinch (grab text) → release (send to PC-B) ---");
  const done = once(a, "transfer:completed");
  a.events.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
  a.events.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.96 });
  await new Promise((r) => setImmediate(r));
  a.events.emit("gesture:pinch-release", { handId: "right", position: { x: 0.8, y: 0.5 }, heldMs: 500 });
  await done;

  const landed = await clipB.readText();
  console.log(`\n📋 PC-B clipboard now holds: "${landed}"`);
  const last = aSys.ledger.recent(1)[0];
  console.log(`📒 transfer completed in ${last?.durationMs}ms (rtt ${last?.rttMs}ms), E2E aes-256-gcm`);
  console.log(
    real
      ? "\n✅ Real clipboard updated — switch to any app and press Ctrl+V.\n"
      : "\n(no native clipboard tool found — used in-memory; install wl-clipboard or xclip for a real paste)\n",
  );

  await new Promise((r) => setTimeout(r, 50));
  await a.stop();
  await b.stop();
  await fs.rm(dirA, { recursive: true, force: true });
  await fs.rm(dirB, { recursive: true, force: true });
  console.log("Demo complete.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
