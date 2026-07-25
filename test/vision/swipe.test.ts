import { describe, it, expect } from "vitest";
import { SwipeDetector, DEFAULT_SWIPE_OPTIONS } from "../../src/vision/swipe.js";
import { openPalmLandmarks } from "./fixtures.js";

function shifted(dx: number, dy = 0) {
  return openPalmLandmarks().map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
}

describe("SwipeDetector", () => {
  it("detects a rightward swipe", () => {
    const d = new SwipeDetector(DEFAULT_SWIPE_OPTIONS);
    let result;
    for (let i = 0; i < 8; i++) result = d.push(shifted(0.06 * i), 1000 + i * 33) ?? result;
    expect(result?.direction).toBe("right");
    expect(result?.velocity).toBeGreaterThan(0);
  });

  it("detects a leftward swipe", () => {
    const d = new SwipeDetector(DEFAULT_SWIPE_OPTIONS);
    let result;
    for (let i = 0; i < 8; i++) result = d.push(shifted(-0.06 * i), 1000 + i * 33) ?? result;
    expect(result?.direction).toBe("left");
  });

  it("ignores mostly-vertical motion", () => {
    const d = new SwipeDetector(DEFAULT_SWIPE_OPTIONS);
    let fired = false;
    for (let i = 0; i < 8; i++) if (d.push(shifted(0, 0.06 * i), 1000 + i * 33)) fired = true;
    expect(fired).toBe(false);
  });

  it("enforces a cooldown (one event per swipe)", () => {
    const d = new SwipeDetector(DEFAULT_SWIPE_OPTIONS);
    let count = 0;
    for (let i = 0; i < 8; i++) if (d.push(shifted(0.06 * i), 1000 + i * 33)) count++;
    expect(count).toBe(1);
  });
});
