/**
 * Vision subsystem demo (no camera required).
 *
 * Drives the VisionEngine with a scripted sequence of synthetic hand landmarks
 * and prints the high-level gesture events it emits on the EventBus. This proves
 * the perception pipeline end-to-end — smoothing → detection → state machine →
 * events — without any MediaPipe/camera dependency.
 *
 *   npm run vision:demo
 */

import { EventBus } from "../src/events/eventBus.js";
import { createLogger } from "../src/utils/logger.js";
import { VisionEngine } from "../src/vision/visionEngine.js";
import { ManualLandmarkSource } from "../src/vision/sources.js";
import { loadVisionConfig } from "../src/vision/config.js";
import type { Landmark, FrameObservation } from "../src/types/gestures.js";

const lm = (x: number, y: number): Landmark => ({ x, y, z: 0 });

/** Build a synthetic right hand; `pinch` closes thumb+index, `dx` shifts it. */
function makeHand(pinch: boolean, dx: number): Landmark[] {
  const base: Landmark[] = [
    lm(0.5, 0.9), lm(0.42, 0.82), lm(0.38, 0.76), lm(0.35, 0.7), lm(0.33, 0.65),
    lm(0.46, 0.66), lm(0.46, 0.57), lm(0.46, 0.52), lm(0.46, 0.4),
    lm(0.5, 0.65), lm(0.5, 0.56), lm(0.5, 0.5), lm(0.5, 0.38),
    lm(0.54, 0.66), lm(0.54, 0.58), lm(0.54, 0.53), lm(0.57, 0.4),
    lm(0.58, 0.68), lm(0.58, 0.61), lm(0.58, 0.57), lm(0.64, 0.44),
  ];
  if (pinch) {
    base[4] = lm(0.475, 0.55); // thumb tip
    base[8] = lm(0.47, 0.55); // index tip meets thumb
    base[12] = lm(0.5, 0.55);
    base[16] = lm(0.54, 0.57);
    base[20] = lm(0.58, 0.6);
  }
  return base.map((p) => ({ ...p, x: p.x + dx }));
}

function frameOf(landmarks: Landmark[], ts: number): FrameObservation {
  return {
    hands: [{ handId: "right", handedness: "right", score: 0.99, landmarks, timestamp: ts }],
    timestamp: ts,
  };
}

async function main(): Promise<void> {
  const bus = new EventBus(createLogger("demo", "silent"));
  const source = new ManualLandmarkSource();
  const engine = new VisionEngine(
    bus,
    source,
    // Motion gestures (swipe) want responsiveness, so use a light EMA here.
    // See docs/PHASE2.md for the smoothing-vs-swipe tuning note.
    loadVisionConfig({
      smoothing: { algorithm: "ema", emaAlpha: 0.8 },
      stateMachine: { enterFrames: 2, mirrorSwipe: false },
    }),
    createLogger("vision", "info"),
  );

  bus.on("gesture:hand-detected", (e) => console.log(`🖐️  hand detected: ${e.handId}`));
  bus.on("gesture:pinch-start", (e) =>
    console.log(`🤏 PINCH START @ (${e.position.x.toFixed(2)}, ${e.position.y.toFixed(2)})`),
  );
  bus.on("gesture:pinch-hold", (e) => console.log(`   …holding ${e.durationMs}ms`));
  bus.on("gesture:pinch-release", (e) => console.log(`✋ PINCH RELEASE (held ${e.heldMs}ms)`));
  bus.on("gesture:open-palm", () => console.log("🖐️  OPEN PALM"));
  bus.on("gesture:swipe-left", (e) => console.log(`⬅️  SWIPE LEFT v=${e.velocity.toFixed(1)}`));
  bus.on("gesture:swipe-right", (e) => console.log(`➡️  SWIPE RIGHT v=${e.velocity.toFixed(1)}`));
  bus.on("gesture:holding-changed", (e) => console.log(`   holding → ${e.holding}`));
  bus.on("gesture:hand-lost", (e) => console.log(`👋 hand lost: ${e.handId}`));

  await engine.start();

  // Scripted sequence: show hand → pinch & hold → release → swipe right → leave.
  let ts = 0;
  const push = (pinch: boolean, dx = 0) => source.emitFrame(frameOf(makeHand(pinch, dx), (ts += 60)));

  console.log("\n--- open palm ---");
  for (let i = 0; i < 3; i++) push(false);
  console.log("\n--- pinch & hold ---");
  for (let i = 0; i < 8; i++) push(true);
  console.log("\n--- release (open) ---");
  for (let i = 0; i < 3; i++) push(false);
  console.log("\n--- swipe right ---");
  for (let i = 0; i < 6; i++) push(false, 0.1 * i);
  console.log("\n--- hand leaves ---");
  source.emitFrame({ hands: [], timestamp: ts + 400 });

  await engine.stop();
  console.log("\nDemo complete.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
