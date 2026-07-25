/**
 * Swipe detector (temporal gesture).
 *
 * Purpose: unlike static poses, a swipe is defined by motion, so it needs a
 * short history of hand positions. This detector tracks the wrist over a sliding
 * time window and fires when it sweeps horizontally far and fast enough, with a
 * cooldown so one physical swipe emits exactly one event.
 *
 * Direction is reported in image space (x grows right). If the camera feed is
 * mirrored, the VisionEngine config can flip it — the detector stays pure.
 */

import { HandLandmark, type Landmark } from "../types/gestures.js";
import { handScale } from "./geometry.js";

export interface SwipeResult {
  direction: "left" | "right";
  /** Horizontal speed in palm-spans per second. */
  velocity: number;
}

export interface SwipeOptions {
  /** History window considered, in ms. */
  windowMs: number;
  /** Minimum horizontal travel (in palm-spans) to count as a swipe. */
  minTravel: number;
  /** Horizontal travel must exceed vertical travel by this factor. */
  horizontalDominance: number;
  /** Ignore further swipes for this long after one fires, in ms. */
  cooldownMs: number;
}

export const DEFAULT_SWIPE_OPTIONS: SwipeOptions = {
  windowMs: 400,
  minTravel: 1.2,
  horizontalDominance: 1.5,
  cooldownMs: 500,
};

interface Sample {
  x: number;
  y: number;
  scale: number;
  t: number;
}

export class SwipeDetector {
  private readonly samples: Sample[] = [];
  private cooldownUntil = 0;

  constructor(private readonly opts: SwipeOptions = DEFAULT_SWIPE_OPTIONS) {}

  /** Feed a frame; returns a SwipeResult on the frame a swipe completes. */
  push(landmarks: Landmark[], timestamp: number): SwipeResult | undefined {
    const wrist = landmarks[HandLandmark.Wrist];
    if (!wrist) return undefined;
    this.samples.push({ x: wrist.x, y: wrist.y, scale: handScale(landmarks), t: timestamp });

    // Drop samples outside the window.
    const cutoff = timestamp - this.opts.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.t < cutoff) this.samples.shift();

    if (timestamp < this.cooldownUntil) return undefined;
    if (this.samples.length < 2) return undefined;

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const scale = Math.max((first.scale + last.scale) / 2, 1e-6);
    const dx = (last.x - first.x) / scale;
    const dy = (last.y - first.y) / scale;
    const dt = Math.max((last.t - first.t) / 1000, 1e-3);

    if (Math.abs(dx) < this.opts.minTravel) return undefined;
    if (Math.abs(dx) < Math.abs(dy) * this.opts.horizontalDominance) return undefined;

    this.cooldownUntil = timestamp + this.opts.cooldownMs;
    this.samples.length = 0;
    return { direction: dx > 0 ? "right" : "left", velocity: Math.abs(dx) / dt };
  }

  reset(): void {
    this.samples.length = 0;
    this.cooldownUntil = 0;
  }
}
