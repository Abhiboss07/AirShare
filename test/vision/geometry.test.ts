import { describe, it, expect } from "vitest";
import { handScale, ramp, clamp01, fingerExtensionRatio, FINGERS } from "../../src/vision/geometry.js";
import { openPalmLandmarks, fistLandmarks } from "./fixtures.js";

describe("geometry", () => {
  it("computes a positive, scale-invariant hand span", () => {
    const s = handScale(openPalmLandmarks());
    expect(s).toBeGreaterThan(0.2);
    expect(s).toBeLessThan(0.35);
  });

  it("ramp maps below/above the band to 0/1 and inverts when one<zero", () => {
    expect(ramp(0.1, 0, 0.2)).toBeCloseTo(0.5);
    expect(ramp(-1, 0, 0.2)).toBe(0);
    expect(ramp(5, 0, 0.2)).toBe(1);
    // Inverted (pinch-style): small value => high confidence.
    expect(ramp(0.3, 0.7, 0.3)).toBe(1);
    expect(ramp(0.7, 0.7, 0.3)).toBe(0);
  });

  it("clamp01 bounds values", () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });

  it("reports index extended for an open palm and curled for a fist", () => {
    expect(fingerExtensionRatio(openPalmLandmarks(), FINGERS[0]!)).toBeGreaterThan(1.2);
    expect(fingerExtensionRatio(fistLandmarks(), FINGERS[0]!)).toBeLessThan(1.05);
  });
});
