import { describe, it, expect } from "vitest";
import { EmaSmoother, OneEuroSmoother, NoopSmoother } from "../../src/vision/smoothing.js";
import type { Landmark } from "../../src/types/gestures.js";

const pt = (x: number, y: number): Landmark => ({ x, y, z: 0 });

describe("smoothing", () => {
  it("Noop passes landmarks through unchanged", () => {
    const s = new NoopSmoother();
    const lms = [pt(0.1, 0.2)];
    expect(s.push(lms, 0)).toBe(lms);
  });

  it("EMA converges toward a constant input and dampens a spike", () => {
    const s = new EmaSmoother(0.5);
    s.push([pt(0, 0)], 0);
    // A spike to 1 should only move halfway on the first step.
    const out = s.push([pt(1, 1)], 33);
    expect(out[0]!.x).toBeCloseTo(0.5);
    // Repeated constant input converges upward.
    let v = out[0]!.x;
    for (let i = 0; i < 10; i++) v = s.push([pt(1, 1)], 66 + i * 33)[0]!.x;
    expect(v).toBeGreaterThan(0.99);
  });

  it("One-Euro returns the first sample verbatim and stays finite", () => {
    const s = new OneEuroSmoother();
    const first = s.push([pt(0.3, 0.4)], 0);
    expect(first[0]!.x).toBeCloseTo(0.3);
    const next = s.push([pt(0.31, 0.41)], 33);
    expect(Number.isFinite(next[0]!.x)).toBe(true);
    expect(next[0]!.x).toBeGreaterThan(0.29);
    expect(next[0]!.x).toBeLessThan(0.32);
  });
});
