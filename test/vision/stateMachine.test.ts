import { describe, it, expect } from "vitest";
import { HandStateMachine, type HandGestureEvent } from "../../src/vision/handStateMachine.js";
import { DEFAULT_SWIPE_OPTIONS } from "../../src/vision/swipe.js";
import { openPalmLandmarks, pinchLandmarks, hand } from "./fixtures.js";

const opts = {
  enterFrames: 2,
  minConfidence: 0.5,
  holdEmitIntervalMs: 50,
  confidenceIntervalMs: 10_000, // silence the confidence stream in this test
  swipe: DEFAULT_SWIPE_OPTIONS,
  mirrorSwipe: false,
};

describe("HandStateMachine", () => {
  it("emits a clean pinch start → hold → release lifecycle", () => {
    const sm = new HandStateMachine(opts);
    const events: HandGestureEvent[] = [];
    const feed = (landmarks: ReturnType<typeof pinchLandmarks>, ts: number) => {
      for (const e of sm.update(hand(landmarks, ts))) events.push(e);
    };

    let ts = 1000;
    for (let i = 0; i < 3; i++) feed(openPalmLandmarks(), (ts += 60));
    for (let i = 0; i < 6; i++) feed(pinchLandmarks(), (ts += 60));
    for (let i = 0; i < 3; i++) feed(openPalmLandmarks(), (ts += 60));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("pinch-start");
    expect(kinds).toContain("pinch-hold");
    expect(kinds).toContain("pinch-release");

    // Holding toggles held then idle, in order.
    const holds = events.filter((e) => e.kind === "holding-changed");
    expect(holds.map((h) => (h as { holding: string }).holding)).toEqual(["held", "idle"]);

    // pinch-start precedes pinch-release.
    expect(kinds.indexOf("pinch-start")).toBeLessThan(kinds.indexOf("pinch-release"));
  });

  it("requires enterFrames of persistence before activating (debounce)", () => {
    const sm = new HandStateMachine({ ...opts, enterFrames: 3 });
    const events: HandGestureEvent[] = [];
    // Two pinch frames only — below the 3-frame threshold → no pinch-start.
    for (const [i] of [0, 1].entries()) {
      for (const e of sm.update(hand(pinchLandmarks(), 1000 + i * 60))) events.push(e);
    }
    expect(events.some((e) => e.kind === "pinch-start")).toBe(false);
  });

  it("finalize releases a held pinch when the hand disappears", () => {
    const sm = new HandStateMachine(opts);
    let ts = 1000;
    for (let i = 0; i < 4; i++) sm.update(hand(pinchLandmarks(), (ts += 60)));
    expect(sm.holdingState).toBe("held");
    const tail = sm.finalize(ts + 200, hand(pinchLandmarks(), ts));
    expect(tail.some((e) => e.kind === "pinch-release")).toBe(true);
    expect(sm.holdingState).toBe("idle");
  });
});
