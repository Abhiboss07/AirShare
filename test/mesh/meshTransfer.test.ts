import { describe, it, expect, afterEach } from "vitest";
import { AirShareNode } from "../../src/core/airShareNode.js";
import { attachTransferMesh, type MeshTransferSystem } from "../../src/mesh/index.js";
import { StaticTargetResolver } from "../../src/transfer/index.js";
import {
  EntityType,
  TransferAction,
  type TransferableEntity,
} from "../../src/types/transfer.js";
import type { EntityProvider, EntitySink } from "../../src/transfer/registry.js";
import { NotImplementedError } from "../../src/transfer/transport.js";
import { tempDataDir, cleanup, waitFor } from "../helpers.js";

/**
 * The Phase-4 milestone: two REAL AirShareNodes (separate identities, real
 * WebSocket sockets, real handshake + session encryption on loopback) move a
 * dummy entity from A to B, driven by gesture events, and B prints it.
 */

const nodes: AirShareNode[] = [];
const systems: MeshTransferSystem[] = [];
const dirs: string[] = [];

async function makeNode(name: string): Promise<AirShareNode> {
  const dataDir = await tempDataDir();
  dirs.push(dataDir);
  const node = new AirShareNode({
    enableDiscovery: false,
    config: {
      deviceName: name,
      dataDir,
      logLevel: "silent",
      network: { port: 0 },
      security: { requirePairingApproval: false }, // auto-trust for the test
    },
  });
  nodes.push(node);
  return node;
}

afterEach(async () => {
  for (const s of systems) s.detach();
  systems.length = 0;
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})));
  nodes.length = 0;
  await Promise.all(dirs.map((d) => cleanup(d)));
  dirs.length = 0;
});

describe("Phase 4 — real device mesh", () => {
  it("transfers a dummy entity A→B over the secure mesh and drops it", async () => {
    const a = await makeNode("PC-A");
    const b = await makeNode("PC-B");
    await a.start();
    await b.start();

    // Establish the secure link.
    const aUp = waitFor(a, "device:connected");
    const bUp = waitFor(b, "device:connected");
    a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
    await Promise.all([aUp, bUp]);

    // B receives; capture what its sink drops.
    const dropped: TransferableEntity[] = [];
    const sink: EntitySink = {
      name: "capture",
      types: [EntityType.Text],
      actions: [TransferAction.Copy],
      drop: (entity) => {
        dropped.push(entity);
      },
    };
    // A produces a dummy text entity on grab.
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

    const aSys = attachTransferMesh(a, {
      supports: ["transfer", "text"],
      providers: [provider],
      targetResolver: new StaticTargetResolver(b.identityInfo.id),
    });
    const bSys = attachTransferMesh(b, { supports: ["transfer", "text"], sinks: [sink] });
    systems.push(aSys, bSys);

    // Drive the gesture sequence on A's bus.
    const completedOnA = waitFor(a, "transfer:completed");
    const metricsOnA = waitFor(a, "transfer:metrics");
    const receivedOnB = waitFor(b, "transfer:received");

    // Wait for the grab to attach the entity before releasing (deterministic).
    const grabbed = waitFor(a, "hand:grab");
    a.events.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
    a.events.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.95 });
    await grabbed;
    a.events.emit("gesture:pinch-release", { handId: "right", position: { x: 0.8, y: 0.5 }, heldMs: 400 });

    await Promise.all([completedOnA, receivedOnB]);
    const metrics = await metricsOnA;

    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.payload).toBe("Hello from PC A");
    expect(dropped[0]!.owner).toBe(a.identityInfo.id);
    expect(metrics.rttMs).toBeGreaterThanOrEqual(0);
    expect(metrics.processingMs).toBeGreaterThanOrEqual(0);
  });

  it("negotiates capabilities between the two devices", async () => {
    const a = await makeNode("PC-A");
    const b = await makeNode("PC-B");
    await a.start();
    await b.start();

    const aSys = attachTransferMesh(a, { supports: ["transfer", "clipboard", "ocr"] });
    const bSys = attachTransferMesh(b, { supports: ["transfer", "files"] });
    systems.push(aSys, bSys);

    const negotiatedOnA = waitFor(a, "capabilities:negotiated");
    const negotiatedOnB = waitFor(b, "capabilities:negotiated");
    a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
    await Promise.all([negotiatedOnA, negotiatedOnB]);

    expect(aSys.capabilities.supports(b.identityInfo.id, "files")).toBe(true);
    expect(aSys.capabilities.supports(b.identityInfo.id, "ocr")).toBe(false);
    expect(bSys.capabilities.supports(a.identityInfo.id, "clipboard")).toBe(true);
  });

  it("exposes a streaming-ready interface that is NotImplemented for now", async () => {
    const a = await makeNode("PC-A");
    await a.start();
    const aSys = attachTransferMesh(a, {});
    systems.push(aSys);
    await expect(aSys.transport.pause("x")).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      aSys.transport.sendStream({ transferId: "x", envelope: {} as never }, (async function* () {})()),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
