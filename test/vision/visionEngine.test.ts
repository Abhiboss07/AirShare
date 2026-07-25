import { describe, it, expect } from "vitest";
import { VisionEngine } from "../../src/vision/visionEngine.js";
import { ManualLandmarkSource } from "../../src/vision/sources.js";
import { loadVisionConfig } from "../../src/vision/config.js";
import { EventBus } from "../../src/events/eventBus.js";
import { createLogger } from "../../src/utils/logger.js";
import type { AirShareEventMap, AirShareEventName } from "../../src/types/events.js";
import { openPalmLandmarks, pinchLandmarks, hand, frame } from "./fixtures.js";

const logger = createLogger("test", "silent");

function recorder(bus: EventBus) {
  const events: { name: AirShareEventName; payload: unknown }[] = [];
  const names: AirShareEventName[] = [
    "vision:started",
    "vision:stopped",
    "gesture:hand-detected",
    "gesture:hand-lost",
    "gesture:pinch-start",
    "gesture:pinch-hold",
    "gesture:pinch-release",
    "gesture:open-palm",
    "gesture:holding-changed",
  ];
  for (const name of names) {
    bus.on(name, (payload: AirShareEventMap[typeof name]) => events.push({ name, payload }));
  }
  return {
    events,
    count: (n: AirShareEventName) => events.filter((e) => e.name === n).length,
    has: (n: AirShareEventName) => events.some((e) => e.name === n),
  };
}

function config() {
  return loadVisionConfig({
    smoothing: { algorithm: "none" },
    stateMachine: { enterFrames: 2, holdEmitIntervalMs: 40, confidenceIntervalMs: 10_000 },
    handLostTimeoutMs: 100,
  });
}

describe("VisionEngine (bus integration)", () => {
  it("emits gesture events for a pinch and reaps a lost hand", async () => {
    const bus = new EventBus(logger);
    const source = new ManualLandmarkSource();
    const engine = new VisionEngine(bus, source, config(), logger);
    const rec = recorder(bus);

    await engine.start();
    expect(rec.has("vision:started")).toBe(true);

    let ts = 1000;
    const feed = (lms: ReturnType<typeof pinchLandmarks>) =>
      source.emitFrame(frame([hand(lms, (ts += 50))], ts));

    for (let i = 0; i < 2; i++) feed(openPalmLandmarks());
    for (let i = 0; i < 4; i++) feed(pinchLandmarks());
    for (let i = 0; i < 2; i++) feed(openPalmLandmarks());

    expect(rec.count("gesture:hand-detected")).toBe(1);
    expect(rec.has("gesture:pinch-start")).toBe(true);
    expect(rec.has("gesture:pinch-release")).toBe(true);

    // A subsequent empty frame past the timeout reaps the hand.
    source.emitFrame(frame([], ts + 200));
    expect(rec.count("gesture:hand-lost")).toBe(1);
    expect(engine.trackedHands).toBe(0);

    await engine.stop();
    expect(rec.has("vision:stopped")).toBe(true);
  });

  it("tracks two hands simultaneously", async () => {
    const bus = new EventBus(logger);
    const source = new ManualLandmarkSource();
    const engine = new VisionEngine(bus, source, config(), logger);
    const rec = recorder(bus);
    await engine.start();

    const ts = 1000;
    source.emitFrame(
      frame(
        [hand(openPalmLandmarks(), ts, "left"), hand(pinchLandmarks(), ts, "right")],
        ts,
      ),
    );

    expect(rec.count("gesture:hand-detected")).toBe(2);
    const detected = rec.events
      .filter((e) => e.name === "gesture:hand-detected")
      .map((e) => (e.payload as { handId: string }).handId)
      .sort();
    expect(detected).toEqual(["left", "right"]);
    expect(engine.trackedHands).toBe(2);
    await engine.stop();
  });
});
