/**
 * Real device-mesh demo (Phase 4).
 *
 * Spins up TWO real AirShareNodes (separate identities, real WebSocket sockets,
 * real authenticated handshake + session encryption) on loopback — a faithful
 * stand-in for two machines. A gesture on A grabs a dummy entity and drops it
 * onto B over the secure mesh; B prints it and A reports end-to-end latency.
 *
 * No clipboard, no files, no UI — just proof the whole distributed runtime works.
 *
 *   npm run mesh:demo
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { AirShareNode } from "../src/core/airShareNode.js";
import { attachTransferMesh } from "../src/mesh/index.js";
import { StaticTargetResolver } from "../src/transfer/index.js";
import { EntityType, TransferAction } from "../src/types/transfer.js";
import type { EntityProvider, EntitySink } from "../src/transfer/registry.js";

async function tmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), "air-share-mesh-demo", randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeNode(name: string, dataDir: string): AirShareNode {
  const node = new AirShareNode({
    enableDiscovery: false,
    config: {
      deviceName: name,
      dataDir,
      logLevel: "silent",
      network: { port: 0 },
      security: { requirePairingApproval: false },
    },
  });
  return node;
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
  const dirA = await tmp();
  const dirB = await tmp();
  const a = makeNode("PC-A", dirA);
  const b = makeNode("PC-B", dirB);
  await a.start();
  await b.start();
  console.log(`PC-A ${a.identityInfo.id.slice(0, 10)}…  on :${a.port}`);
  console.log(`PC-B ${b.identityInfo.id.slice(0, 10)}…  on :${b.port}`);

  const provider: EntityProvider = {
    name: "dummy",
    types: [EntityType.Text],
    capture: () => ({
      type: EntityType.Text,
      metadata: { name: "greeting.txt", sizeBytes: 15 },
      payload: "Hello from PC A",
      permissions: { transferable: true, persistable: true },
    }),
  };
  const sink: EntitySink = {
    name: "printer",
    types: [EntityType.Text],
    actions: [TransferAction.Copy],
    drop: (entity) => {
      console.log(`\n📥 PC-B received & dropped: "${entity.payload}"`);
      console.log(`🔐 object encrypted end-to-end with: ${entity.encryption?.algorithm}\n`);
    },
  };

  const aSys = attachTransferMesh(a, {
    supports: ["transfer", "text"],
    providers: [provider],
    targetResolver: new StaticTargetResolver(b.identityInfo.id),
  });
  attachTransferMesh(b, { supports: ["transfer", "text"], sinks: [sink] });

  a.on("capabilities:negotiated", (e) =>
    console.log(`🤝 PC-A learned PC-B supports: [${e.capabilities.join(", ")}]`),
  );
  a.on("transfer:metrics", (m) =>
    console.log(
      `⏱️  latency: rtt=${m.rttMs}ms  processing=${m.processingMs}ms  ~network=${m.estimatedNetworkMs}ms`,
    ),
  );

  // Connect the two devices over the secure mesh.
  const connected = Promise.all([once(a, "device:connected"), once(b, "device:connected")]);
  a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
  await connected;
  console.log("🔗 secure mesh established (handshake + AES-256-GCM session)");

  console.log("\n--- gesture on PC-A: pinch (grab) → release (send to PC-B) ---");
  const done = once(a, "transfer:completed");
  a.events.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
  a.events.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.96 });
  await new Promise((r) => setImmediate(r));
  a.events.emit("gesture:pinch-release", { handId: "right", position: { x: 0.8, y: 0.5 }, heldMs: 500 });
  await done;
  console.log("✅ PC-A: transfer completed");

  const stats = aSys.ledger.analytics();
  const last = aSys.ledger.recent(1)[0];
  console.log(
    `📒 ledger: ${stats.completed}/${stats.total} completed ` +
      `(success ${(stats.successRate * 100).toFixed(0)}%), ` +
      `last → ${last?.dest?.slice(0, 10)}… in ${last?.durationMs}ms, rtt ${last?.rttMs}ms`,
  );

  await new Promise((r) => setTimeout(r, 50));
  await a.stop();
  await b.stop();
  await fs.rm(dirA, { recursive: true, force: true });
  await fs.rm(dirB, { recursive: true, force: true });
  console.log("\nDemo complete.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
