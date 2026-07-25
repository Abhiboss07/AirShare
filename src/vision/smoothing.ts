/**
 * Landmark smoothing.
 *
 * Purpose: raw hand-tracking landmarks jitter frame-to-frame. Smoothing reduces
 * jitter (steadier gestures, calmer UI) without adding perceptible lag. The
 * `LandmarkSmoother` interface lets us swap algorithms; Phase 2 ships an
 * exponential-moving-average smoother and a One-Euro filter, both pure and
 * deterministic given their inputs.
 *
 * Design: a smoother is stateful *per hand*, so the engine holds one instance
 * per tracked hand. Detectors run on the smoothed output.
 */

import type { Landmark } from "../types/gestures.js";

export interface LandmarkSmoother {
  /** Feed one frame of landmarks; returns the smoothed landmarks. */
  push(landmarks: Landmark[], timestamp: number): Landmark[];
  reset(): void;
}

/** Pass-through smoother (smoothing disabled). */
export class NoopSmoother implements LandmarkSmoother {
  push(landmarks: Landmark[], _timestamp: number): Landmark[] {
    void _timestamp;
    return landmarks;
  }
  reset(): void {
    /* nothing to reset */
  }
}

/**
 * Exponential moving average: `out = out + alpha*(in - out)`.
 * `alpha` in (0,1]; higher = more responsive/less smooth. Simple, cheap, and
 * good enough for steady gestures; the default when latency matters less.
 */
export class EmaSmoother implements LandmarkSmoother {
  private prev: Landmark[] | undefined;

  constructor(private readonly alpha = 0.5) {}

  push(landmarks: Landmark[], _timestamp: number): Landmark[] {
    void _timestamp;
    if (!this.prev || this.prev.length !== landmarks.length) {
      this.prev = landmarks.map((l) => ({ ...l }));
      return this.prev.map((l) => ({ ...l }));
    }
    const out = landmarks.map((l, i) => {
      const p = this.prev![i]!;
      return {
        x: p.x + this.alpha * (l.x - p.x),
        y: p.y + this.alpha * (l.y - p.y),
        z: p.z + this.alpha * (l.z - p.z),
      };
    });
    this.prev = out.map((l) => ({ ...l }));
    return out;
  }

  reset(): void {
    this.prev = undefined;
  }
}

/**
 * One-Euro filter (Casiez et al. 2012): adaptive low-pass that smooths more at
 * low speed (kills jitter when the hand is still) and less at high speed (keeps
 * fast motion responsive). Preferred when both steadiness and low lag matter.
 */
export class OneEuroSmoother implements LandmarkSmoother {
  private prev: Landmark[] | undefined;
  private dPrev: Landmark[] | undefined;
  private tPrev: number | undefined;

  constructor(
    private readonly minCutoff = 1.0,
    private readonly beta = 0.007,
    private readonly dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  push(landmarks: Landmark[], timestamp: number): Landmark[] {
    const tSec = timestamp / 1000;
    if (!this.prev || this.tPrev === undefined || this.prev.length !== landmarks.length) {
      this.prev = landmarks.map((l) => ({ ...l }));
      this.dPrev = landmarks.map(() => ({ x: 0, y: 0, z: 0 }));
      this.tPrev = tSec;
      return this.prev.map((l) => ({ ...l }));
    }
    const dt = Math.max(tSec - this.tPrev, 1e-3);
    this.tPrev = tSec;

    const out: Landmark[] = landmarks.map((l, i) => {
      const p = this.prev![i]!;
      const dp = this.dPrev![i]!;
      const smoothAxis = (cur: number, prev: number, dPrev: number): [number, number] => {
        const dRaw = (cur - prev) / dt;
        const dHat = dPrev + OneEuroSmoother.alpha(this.dCutoff, dt) * (dRaw - dPrev);
        const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
        const hat = prev + OneEuroSmoother.alpha(cutoff, dt) * (cur - prev);
        return [hat, dHat];
      };
      const [x, dx] = smoothAxis(l.x, p.x, dp.x);
      const [y, dy] = smoothAxis(l.y, p.y, dp.y);
      const [z, dz] = smoothAxis(l.z, p.z, dp.z);
      this.dPrev![i] = { x: dx, y: dy, z: dz };
      return { x, y, z };
    });
    this.prev = out.map((l) => ({ ...l }));
    return out;
  }

  reset(): void {
    this.prev = undefined;
    this.dPrev = undefined;
    this.tPrev = undefined;
  }
}
