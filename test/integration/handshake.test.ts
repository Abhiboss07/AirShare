import { describe, it, expect, afterEach } from "vitest";
import { AirShareNode } from "../../src/core/airShareNode.js";
import { MessageType } from "../../src/types/messages.js";
import { tempDataDir, cleanup, waitFor } from "../helpers.js";

/**
 * End-to-end over real WebSockets on loopback, with mDNS disabled so the test
 * is deterministic. Exercises: signed handshake -> key agreement -> pairing ->
 * trust persistence -> encrypted messaging -> heartbeat.
 */

const dirs: string[] = [];
const nodes: AirShareNode[] = [];

async function makeNode(name: string, autoPair: boolean): Promise<AirShareNode> {
  const dataDir = await tempDataDir();
  dirs.push(dataDir);
  const node = new AirShareNode({
    enableDiscovery: false,
    config: {
      deviceName: name,
      dataDir,
      logLevel: "silent",
      network: { port: 0 },
      heartbeat: { intervalMs: 200, timeoutMs: 150, maxMissed: 3 },
      // Require explicit approval so we test the pairing round-trip.
      security: { requirePairingApproval: true },
    },
  });
  if (autoPair) {
    node.on("pair:request", ({ accept }) => accept());
  }
  nodes.push(node);
  return node;
}

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})));
  nodes.length = 0;
  await Promise.all(dirs.map((d) => cleanup(d)));
  dirs.length = 0;
});

describe("two-node handshake", () => {
  it("pairs, exchanges an encrypted message and heartbeats", async () => {
    const a = await makeNode("Node-A", true);
    const b = await makeNode("Node-B", true);
    await a.start();
    await b.start();

    const aConnected = waitFor(a, "device:connected");
    const bConnected = waitFor(b, "device:connected");

    a.connectTo("127.0.0.1", b.port, b.identityInfo.id);

    const [aEvt, bEvt] = await Promise.all([aConnected, bConnected]);
    expect(aEvt.device.identity.id).toBe(b.identityInfo.id);
    expect(bEvt.device.identity.id).toBe(a.identityInfo.id);

    // Both sides should now have persisted trust.
    expect((await a.listTrusted()).some((t) => t.id === b.identityInfo.id)).toBe(true);
    expect((await b.listTrusted()).some((t) => t.id === a.identityInfo.id)).toBe(true);

    // Encrypted application message A -> B.
    const received = waitFor(b, "message:received");
    expect(a.sendTo(b.identityInfo.id, "greeting", { hello: "world" })).toBe(true);
    const msg = await received;
    expect(msg.from).toBe(a.identityInfo.id);
    expect(msg.envelope.type).toBe(MessageType.Message);
    expect((msg.envelope.payload as { data: unknown }).data).toEqual({ hello: "world" });

    // Heartbeat should produce an RTT reading.
    const hb = await waitFor(a, "heartbeat:ok", 3000);
    expect(hb.rttMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects pairing when the user declines", async () => {
    const a = await makeNode("Node-A", true);
    const b = await makeNode("Node-B", false);
    b.on("pair:request", ({ reject }) => reject("no thanks"));
    await a.start();
    await b.start();

    const disconnected = waitFor(a, "device:disconnected", 4000);
    a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
    await disconnected;

    expect((await b.listTrusted()).length).toBe(0);
  });
});
