/**
 * Latency breakdown (pre-Phase-6 instrumentation).
 *
 * Measures each stage of the pinch→clipboard pipeline with real crypto and real
 * WebSocket sockets on loopback, plus the vision pipeline's per-frame cost. Runs
 * many iterations and reports the median of each stage so we know whether the
 * interaction feels instant (< ~20–30 ms on a LAN).
 *
 *   npm run latency:demo
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AirShareNode } from "../src/core/airShareNode.js";
import { attachTransferMesh } from "../src/mesh/index.js";
import {
  StaticTargetResolver,
  AesGcmCipher,
  NoopCipher,
  type CipherProvider,
  type EntityCipher,
} from "../src/transfer/index.js";
import {
  InMemoryClipboardBackend,
  clipboardProvider,
  clipboardSink,
} from "../src/content/index.js";
import type { EntitySink } from "../src/transfer/registry.js";
import { EventBus } from "../src/events/eventBus.js";
import { VisionEngine } from "../src/vision/visionEngine.js";
import { ManualLandmarkSource } from "../src/vision/sources.js";
import { loadVisionConfig } from "../src/vision/config.js";
import { createLogger } from "../src/utils/logger.js";
import type { Landmark, FrameObservation } from "../src/types/gestures.js";
import type { AirShareEventName, AirShareEventMap } from "../src/types/events.js";

const ITERATIONS = 60;
const WARMUP = 10;

/** Nanoseconds since `start` (a hrtime bigint), as milliseconds. */
function since(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Per-iteration timing scratchpad, filled by the instrumented wrappers. */
interface Rec {
  encryptMs: number;
  decryptMs: number;
  clipboardMs: number;
  sinkDoneAt: number;
}
const rec: Rec = { encryptMs: 0, decryptMs: 0, clipboardMs: 0, sinkDoneAt: 0 };

/** A cipher provider that keys real AES-256-GCM from the session and times it. */
class TimingCipherProvider implements CipherProvider {
  constructor(private readonly node: AirShareNode) {}
  cipherFor(peerId: string): EntityCipher {
    const key = this.node.entityKeyFor(peerId);
    const inner: EntityCipher = key ? new AesGcmCipher(key) : new NoopCipher();
    return {
      algorithm: inner.algorithm,
      async encrypt(pt) {
        const t = process.hrtime.bigint();
        const r = await inner.encrypt(pt);
        rec.encryptMs = since(t);
        return r;
      },
      async decrypt(ct, meta) {
        const t = process.hrtime.bigint();
        const r = await inner.decrypt(ct, meta);
        rec.decryptMs = since(t);
        return r;
      },
    };
  }
}

function waitFor<K extends AirShareEventName>(node: AirShareNode, event: K): Promise<AirShareEventMap[K]> {
  return new Promise((resolve) => {
    const off = node.on(event, (p) => {
      off();
      resolve(p);
    });
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function fmt(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

async function tmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), "air-share-latency", randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ---- Vision per-frame cost -------------------------------------------------

const lm = (x: number, y: number): Landmark => ({ x, y, z: 0 });
function pinchHand(): Landmark[] {
  const base: Landmark[] = [
    lm(0.5, 0.9), lm(0.42, 0.82), lm(0.38, 0.76), lm(0.35, 0.7), lm(0.475, 0.55),
    lm(0.46, 0.66), lm(0.46, 0.57), lm(0.46, 0.52), lm(0.47, 0.55),
    lm(0.5, 0.65), lm(0.5, 0.56), lm(0.5, 0.5), lm(0.5, 0.55),
    lm(0.54, 0.66), lm(0.54, 0.58), lm(0.54, 0.53), lm(0.54, 0.57),
    lm(0.58, 0.68), lm(0.58, 0.61), lm(0.58, 0.57), lm(0.58, 0.6),
  ];
  return base;
}
function frameOf(landmarks: Landmark[], ts: number): FrameObservation {
  return { hands: [{ handId: "right", handedness: "right", score: 0.99, landmarks, timestamp: ts }], timestamp: ts };
}

async function measureVision(): Promise<number> {
  const bus = new EventBus(createLogger("v", "silent"));
  const source = new ManualLandmarkSource();
  const engine = new VisionEngine(bus, source, loadVisionConfig(), createLogger("v", "silent"));
  await engine.start();
  const samples: number[] = [];
  let ts = 0;
  for (let i = 0; i < ITERATIONS + WARMUP; i++) {
    const frame = frameOf(pinchHand(), (ts += 33)); // ~30 fps
    const t = process.hrtime.bigint();
    source.emitFrame(frame); // smoothing → detection → state machine → events (synchronous)
    const dt = since(t);
    if (i >= WARMUP) samples.push(dt);
  }
  await engine.stop();
  return median(samples);
}

// ---- Transfer path ---------------------------------------------------------

async function main(): Promise<void> {
  const visionPerFrame = await measureVision();

  const dirA = await tmp();
  const dirB = await tmp();
  const mk = (name: string, dataDir: string): AirShareNode =>
    new AirShareNode({
      enableDiscovery: false,
      config: { deviceName: name, dataDir, logLevel: "silent", network: { port: 0 }, security: { requirePairingApproval: false } },
    });
  const a = mk("PC-A", dirA);
  const b = mk("PC-B", dirB);
  await a.start();
  await b.start();

  const aUp = waitFor(a, "device:connected");
  const bUp = waitFor(b, "device:connected");
  a.connectTo("127.0.0.1", b.port, b.identityInfo.id);
  await Promise.all([aUp, bUp]);

  const clipA = new InMemoryClipboardBackend("Hello from PC-A — paste me!");
  const clipB = new InMemoryClipboardBackend();
  const realSink = clipboardSink(clipB);
  const timedSink: EntitySink = {
    ...realSink,
    async drop(entity, action) {
      const t = process.hrtime.bigint();
      await realSink.drop(entity, action);
      rec.clipboardMs = since(t);
      rec.sinkDoneAt = performance.now();
    },
  };

  attachTransferMesh(a, {
    providers: [clipboardProvider(clipA)],
    cipherProvider: new TimingCipherProvider(a),
    targetResolver: new StaticTargetResolver(b.identityInfo.id),
  });
  attachTransferMesh(b, { sinks: [timedSink], cipherProvider: new TimingCipherProvider(b) });

  const grabMs: number[] = [];
  const encryptMs: number[] = [];
  const networkMs: number[] = [];
  const decryptMs: number[] = [];
  const clipboardMs: number[] = [];
  const totalMs: number[] = [];

  a.events.emit("gesture:hand-detected", { handId: "right", handedness: "right" });

  for (let i = 0; i < ITERATIONS + WARMUP; i++) {
    const grabbed = waitFor(a, "hand:grab");
    const completed = waitFor(a, "transfer:completed");
    const metrics = waitFor(a, "transfer:metrics");

    const tStart = performance.now();
    const tGrabHr = process.hrtime.bigint();
    a.events.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.96 });
    await grabbed;
    const grab = since(tGrabHr);
    a.events.emit("gesture:pinch-release", { handId: "right", position: { x: 0.8, y: 0.5 }, heldMs: 200 });
    await completed;
    const m = await metrics;
    const total = rec.sinkDoneAt - tStart;

    if (i >= WARMUP) {
      grabMs.push(grab);
      encryptMs.push(rec.encryptMs);
      decryptMs.push(rec.decryptMs);
      clipboardMs.push(rec.clipboardMs);
      networkMs.push(m.estimatedNetworkMs ?? m.rttMs / 2);
      totalMs.push(total);
    }
  }

  await a.stop();
  await b.stop();
  await fs.rm(dirA, { recursive: true, force: true });
  await fs.rm(dirB, { recursive: true, force: true });

  const row = (label: string, ms: number) => `  ${label.padEnd(26)} ${fmt(ms).padStart(10)}`;
  console.log(`\nLatency breakdown — median of ${ITERATIONS} iterations (loopback, real crypto)\n`);
  console.log(row("Gesture detection /frame", visionPerFrame));
  console.log(row("Entity creation (grab)", median(grabMs)));
  console.log(row("Encryption (AES-256-GCM)", median(encryptMs)));
  console.log(row("Network (one-way est.)", median(networkMs)));
  console.log(row("Decryption (AES-256-GCM)", median(decryptMs)));
  console.log(row("Clipboard write", median(clipboardMs)));
  console.log("  " + "-".repeat(37));
  console.log(row("End-to-end (pinch→clip)", median(totalMs)));
  console.log(
    `\nInteraction target: < ~20–30 ms on a LAN → ${
      median(totalMs) < 30 ? "✅ feels instant (loopback)" : "⚠️ over budget"
    }`,
  );
  console.log("Note: total is measured directly; stages are diagnostic and include event/dispatch overhead.\n");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
