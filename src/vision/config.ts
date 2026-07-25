/**
 * Vision subsystem configuration.
 *
 * Purpose: all vision tunables in one typed place with documented defaults —
 * mirroring the networking config philosophy (no magic numbers scattered in the
 * detectors). `loadVisionConfig` merges partial overrides onto the defaults.
 */

import { DEFAULT_SWIPE_OPTIONS, type SwipeOptions } from "./swipe.js";
import type { HandStateMachineOptions } from "./handStateMachine.js";

export type SmoothingAlgorithm = "ema" | "one-euro" | "none";

export interface SmoothingConfig {
  algorithm: SmoothingAlgorithm;
  emaAlpha: number;
  oneEuro: { minCutoff: number; beta: number; dCutoff: number };
}

export interface VisionConfig {
  smoothing: SmoothingConfig;
  stateMachine: HandStateMachineOptions;
  /** Drop a hand (emit hand-lost) after this long without an observation, ms. */
  handLostTimeoutMs: number;
}

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  smoothing: {
    algorithm: "one-euro",
    emaAlpha: 0.5,
    oneEuro: { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 },
  },
  stateMachine: {
    enterFrames: 3, // ~100ms at 30fps before a gesture is confirmed
    minConfidence: 0.5,
    holdEmitIntervalMs: 250,
    confidenceIntervalMs: 200,
    swipe: DEFAULT_SWIPE_OPTIONS,
    mirrorSwipe: true, // most front-facing cameras present a mirrored image
  },
  handLostTimeoutMs: 300,
};

export type PartialVisionConfig = {
  smoothing?: Partial<SmoothingConfig>;
  stateMachine?: Partial<HandStateMachineOptions> & { swipe?: Partial<SwipeOptions> };
  handLostTimeoutMs?: number;
};

export function loadVisionConfig(overrides: PartialVisionConfig = {}): VisionConfig {
  const base = DEFAULT_VISION_CONFIG;
  return {
    handLostTimeoutMs: overrides.handLostTimeoutMs ?? base.handLostTimeoutMs,
    smoothing: {
      ...base.smoothing,
      ...overrides.smoothing,
      oneEuro: { ...base.smoothing.oneEuro, ...overrides.smoothing?.oneEuro },
    },
    stateMachine: {
      ...base.stateMachine,
      ...overrides.stateMachine,
      swipe: { ...base.stateMachine.swipe, ...overrides.stateMachine?.swipe },
    },
  };
}
