import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { ExperienceBridge } from "../../src/bridge/index.js";
import type { RawHandLandmarkerResult } from "../../src/vision/mediapipeAdapter.js";

/**
 * Proves the Phase-6 loop end-to-end with no browser and no camera: a WebSocket
 * client (standing in for the browser) streams scripted MediaPipe landmarks; the
 * bridge runs the real vision → grab → E2E-encrypt → mesh → clipboard pipeline
 * on two real nodes and relays the events back. We assert the pipeline fired and
 * PC-B's clipboard actually received PC-A's text.
 */

let bridge: ExperienceBridge | undefined;
let client: BufferedClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await bridge?.stop();
  bridge = undefined;
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// A 21-point right hand; `pinch` closes thumb+index. Mirrors the vision demo.
const lm = (x: number, y: number) => ({ x, y, z: 0 });
function hand(pinch: boolean): { x: number; y: number; z: number }[] {
  const base = [
    lm(0.5, 0.9), lm(0.42, 0.82), lm(0.38, 0.76), lm(0.35, 0.7), lm(0.33, 0.65),
    lm(0.46, 0.66), lm(0.46, 0.57), lm(0.46, 0.52), lm(0.46, 0.4),
    lm(0.5, 0.65), lm(0.5, 0.56), lm(0.5, 0.5), lm(0.5, 0.38),
    lm(0.54, 0.66), lm(0.54, 0.58), lm(0.54, 0.53), lm(0.57, 0.4),
    lm(0.58, 0.68), lm(0.58, 0.61), lm(0.58, 0.57), lm(0.64, 0.44),
  ];
  if (pinch) {
    base[4] = lm(0.475, 0.55);
    base[8] = lm(0.47, 0.55);
    base[12] = lm(0.5, 0.55);
    base[16] = lm(0.54, 0.57);
    base[20] = lm(0.58, 0.6);
  }
  return base;
}
function rawResult(pinch: boolean): RawHandLandmarkerResult {
  return { landmarks: [hand(pinch)], handedness: [[{ categoryName: "Right", score: 0.99 }]] };
}

interface AnyMsg { type: string; event?: string; payload?: unknown; nodes?: { tag: string; name: string }[] }

/** A ws client that buffers every message from the moment it opens. */
class BufferedClient {
  private readonly ws: WebSocket;
  private readonly seen: AnyMsg[] = [];
  private readonly waiters: Array<{ pred: (m: AnyMsg) => boolean; resolve: (m: AnyMsg) => void }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as AnyMsg;
      this.seen.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i]!.pred(msg)) {
          this.waiters.splice(i, 1)[0]!.resolve(msg);
        }
      }
    });
  }

  static connect(port: number): Promise<BufferedClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = new BufferedClient(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }

  waitFor(pred: (m: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
    const existing = this.seen.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  waitForEvent(event: string, timeoutMs?: number): Promise<AnyMsg> {
    return this.waitFor((m) => m.type === "event" && m.event === event, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

describe("Phase 6 — experience bridge", () => {
  it("sends an init message naming both device tiles on connect", async () => {
    bridge = new ExperienceBridge({ port: 0, logLevel: "silent" });
    const { port } = await bridge.start();
    client = await BufferedClient.connect(port);
    const init = await client.waitFor((m) => m.type === "init");
    expect(init.nodes?.map((n) => n.tag)).toEqual(["A", "B"]);
    expect(init.nodes?.map((n) => n.name)).toEqual(["PC-A", "PC-B"]);
  });

  it("runs the real pipeline from scripted landmarks and updates PC-B's clipboard", async () => {
    bridge = new ExperienceBridge({ port: 0, logLevel: "silent", clipboardText: "beamed from PC-A" });
    const { port } = await bridge.start();
    client = await BufferedClient.connect(port);

    let ts = 0;
    const push = async (pinch: boolean): Promise<void> => {
      bridge!.pushLandmarks(rawResult(pinch), (ts += 33));
      await tick(); // let the async grab/transfer interleave between frames
    };

    const grabbed = client.waitForEvent("hand:grab");
    // Hold a pinch until the grab attaches the entity (continuous-frame style).
    await push(false);
    await push(false);
    for (let i = 0; i < 8; i++) await push(true);
    await grabbed;

    // Open the hand → release → transfer → PC-B clipboard write.
    const clipboardUpdated = client.waitForEvent("clipboard:updated");
    for (let i = 0; i < 6; i++) await push(false);
    const msg = await clipboardUpdated;

    expect((msg.payload as { text: string }).text).toBe("beamed from PC-A");
    expect(await bridge.destinationClipboard.readText()).toBe("beamed from PC-A");
  });
});
