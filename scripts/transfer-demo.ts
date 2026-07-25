/**
 * Transfer Runtime demo (no camera, no network).
 *
 * Two in-process "devices" (A and B) share an in-memory transfer switch. Device
 * A registers a clipboard-style provider; device B registers a sink that "drops"
 * whatever arrives. We then replay a gesture sequence on A's bus — detect →
 * pinch (grab) → point (aim at B) → release (send) — and watch the entity travel
 * through its full lifecycle and land on B.
 *
 *   npm run transfer:demo
 */

import { randomBytes } from "node:crypto";
import { EventBus } from "../src/events/eventBus.js";
import { createLogger } from "../src/utils/logger.js";
import {
  composeTransferRuntime,
  InMemoryTransferSwitch,
  InMemoryTransferTransport,
  AesGcmCipher,
  StaticTargetResolver,
} from "../src/transfer/index.js";
import { EntityType, TransferAction } from "../src/types/transfer.js";
import type { EntityProvider, EntitySink } from "../src/transfer/index.js";

const flush = () => new Promise((r) => setImmediate(r));

const clipboardProvider: EntityProvider = {
  name: "clipboard",
  types: [EntityType.Text],
  capture: () => ({
    type: EntityType.Text,
    metadata: { name: "clipboard.txt", mimeType: "text/plain", sizeBytes: 20 },
    payload: "✦ pinched text ✦",
    preview: { kind: "text", text: "✦ pinched text ✦" },
    permissions: { transferable: true, persistable: true },
  }),
};

const desktopSink: EntitySink = {
  name: "desktop",
  types: [EntityType.Text, EntityType.Image, EntityType.File],
  actions: [TransferAction.Copy, TransferAction.Paste],
  drop: (entity) => {
    console.log(`   📥 B dropped ${entity.type}: ${JSON.stringify(entity.payload)}`);
  },
};

async function main(): Promise<void> {
  const sw = new InMemoryTransferSwitch();
  const key = randomBytes(32); // stand-in for the Phase-5 session key

  const busA = new EventBus(createLogger("A", "silent"));
  const A = composeTransferRuntime({
    localDeviceId: "device-A",
    eventBus: busA,
    transport: new InMemoryTransferTransport("device-A", sw),
    logger: createLogger("A", "info"),
    cipher: new AesGcmCipher(key),
    targetResolver: new StaticTargetResolver("device-B"),
  });
  A.registry.registerProvider(clipboardProvider);
  A.runtime.attach();

  const busB = new EventBus(createLogger("B", "silent"));
  const B = composeTransferRuntime({
    localDeviceId: "device-B",
    eventBus: busB,
    transport: new InMemoryTransferTransport("device-B", sw),
    logger: createLogger("B", "info"),
    cipher: new AesGcmCipher(key),
  });
  B.registry.registerSink(desktopSink);
  B.runtime.attach();

  // Narrate the entity lifecycle on the source.
  busA.on("hand:grab", (e) => console.log(`🤏 A grabbed ${e.entityType} (${e.entityId.slice(0, 8)}…)`));
  busA.on("entity:state", (e) => console.log(`   A: ${e.from} → ${e.to}`));
  busA.on("hand:target-changed", (e) => console.log(`🎯 A aims at ${e.targetDeviceId}`));
  busA.on("transfer:completed", () => console.log("✅ A: transfer completed"));
  busB.on("transfer:received", (e) => console.log(`📨 B received ${e.type} from ${e.from}`));

  console.log("\n--- gesture: hand appears, pinches (grab) ---");
  busA.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
  busA.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.96 });
  await flush();

  console.log("\n--- gesture: point at device B ---");
  busA.emit("gesture:point", {
    handId: "right",
    position: { x: 0.6, y: 0.4 },
    direction: { x: 0.8, y: -0.2 },
    confidence: 0.9,
  });

  console.log("\n--- gesture: release (drop → send to B) ---");
  busA.emit("gesture:pinch-release", { handId: "right", position: { x: 0.9, y: 0.4 }, heldMs: 620 });
  await flush();
  await flush();

  console.log("\nDemo complete.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
