import { describe, it, expect, afterEach } from "vitest";
import { AirShareNode } from "../../src/core/airShareNode.js";
import { attachTransferMesh, type MeshTransferSystem } from "../../src/mesh/index.js";
import { StaticTargetResolver } from "../../src/transfer/index.js";
import {
  InMemoryClipboardBackend,
  clipboardProvider,
  clipboardSink,
} from "../../src/content/index.js";
import { tempDataDir, cleanup, waitFor } from "../helpers.js";

/**
 * Phase 5B target workflow, headless: PC A grabs its clipboard text, it travels
 * end-to-end encrypted over the real mesh, and PC B's clipboard sink writes it —
 * the "now hit Ctrl+V on PC B" moment, proven with in-memory clipboards.
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
      security: { requirePairingApproval: false },
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

describe("Phase 5B — clipboard transfer over the mesh", () => {
  it("moves PC A's clipboard text to PC B's clipboard, end-to-end encrypted", async () => {
    const a = await makeNode("PC-A");
    const b = await makeNode("PC-B");
    await a.start();
    await b.start();

    const aUp = waitFor(a, "device:connected");
    const bUp = waitFor(b, "device:connected");
    a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
    await Promise.all([aUp, bUp]);

    const clipA = new InMemoryClipboardBackend("Ctrl+V me on PC B");
    const clipB = new InMemoryClipboardBackend();

    const aSys = attachTransferMesh(a, {
      supports: ["transfer", "clipboard"],
      providers: [clipboardProvider(clipA)],
      targetResolver: new StaticTargetResolver(b.identityInfo.id),
    });
    const bSys = attachTransferMesh(b, {
      supports: ["transfer", "clipboard"],
      sinks: [clipboardSink(clipB)],
    });
    systems.push(aSys, bSys);

    const completedOnA = waitFor(a, "transfer:completed");
    const receivedOnB = waitFor(b, "transfer:received");
    const grabbed = waitFor(a, "hand:grab");
    a.events.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
    a.events.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.95 });
    await grabbed;
    a.events.emit("gesture:pinch-release", { handId: "right", position: { x: 0.8, y: 0.5 }, heldMs: 400 });

    await Promise.all([completedOnA, receivedOnB]);

    // PC B's clipboard now holds PC A's text.
    expect(await clipB.readText()).toBe("Ctrl+V me on PC B");
    // ...and it crossed the wire under real end-to-end AES-256-GCM.
    const dest = bSys.ledger.recent(1)[0]!;
    expect(dest.outcome).toBe("completed");
    expect(dest.source).toBe(a.identityInfo.id);
  });
});
