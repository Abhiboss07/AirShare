import { HAND_LANDMARK_COUNT, type HandObservation, type Landmark } from "../../src/types/gestures.js";
import type { FrameObservation } from "../../src/types/gestures.js";

/**
 * Synthetic hand poses in normalized image coordinates (y grows downward,
 * fingers point "up" = smaller y). These are deliberately hand-authored so the
 * gesture tests are fully deterministic — no camera, no ML model.
 */

function lm(x: number, y: number, z = 0): Landmark {
  return { x, y, z };
}

// Shared lower-hand anatomy (wrist, thumb base, MCP/PIP rows).
const BASE: Landmark[] = [
  lm(0.5, 0.9), // 0 wrist
  lm(0.42, 0.82), // 1 thumb cmc
  lm(0.38, 0.76), // 2 thumb mcp
  lm(0.35, 0.7), // 3 thumb ip
  lm(0.33, 0.65), // 4 thumb tip (overridden per pose)
  lm(0.46, 0.66), // 5 index mcp
  lm(0.46, 0.57), // 6 index pip
  lm(0.46, 0.52), // 7 index dip
  lm(0.46, 0.49), // 8 index tip (overridden)
  lm(0.5, 0.65), // 9 middle mcp
  lm(0.5, 0.56), // 10 middle pip
  lm(0.5, 0.5), // 11 middle dip
  lm(0.5, 0.47), // 12 middle tip (overridden)
  lm(0.54, 0.66), // 13 ring mcp
  lm(0.54, 0.58), // 14 ring pip
  lm(0.54, 0.53), // 15 ring dip
  lm(0.54, 0.5), // 16 ring tip (overridden)
  lm(0.58, 0.68), // 17 pinky mcp
  lm(0.58, 0.61), // 18 pinky pip
  lm(0.58, 0.57), // 19 pinky dip
  lm(0.58, 0.54), // 20 pinky tip (overridden)
];

function withTips(overrides: Partial<Record<number, Landmark>>): Landmark[] {
  const arr = BASE.map((l) => ({ ...l }));
  for (const [idx, val] of Object.entries(overrides)) arr[Number(idx)] = { ...val! };
  if (arr.length !== HAND_LANDMARK_COUNT) throw new Error("bad fixture length");
  return arr;
}

/** Open palm: all fingers extended (tips high) and spread; thumb out. */
export function openPalmLandmarks(): Landmark[] {
  return withTips({
    4: lm(0.28, 0.62), // thumb out to the side
    8: lm(0.42, 0.4), // index extended
    12: lm(0.5, 0.38), // middle extended
    16: lm(0.57, 0.4), // ring extended
    20: lm(0.64, 0.44), // pinky extended, spread
  });
}

/** Pinch: thumb tip and index tip together, other fingers relaxed/curled. */
export function pinchLandmarks(): Landmark[] {
  return withTips({
    4: lm(0.475, 0.55), // thumb tip meets index tip
    8: lm(0.47, 0.55),
    12: lm(0.5, 0.55), // other fingers relaxed (not spread/extended)
    16: lm(0.54, 0.57),
    20: lm(0.58, 0.6),
  });
}

/** Neutral, relaxed hand: no clear gesture (classifies as None). */
export function neutralLandmarks(): Landmark[] {
  return withTips({
    4: lm(0.34, 0.66),
    8: lm(0.46, 0.54),
    12: lm(0.5, 0.53),
    16: lm(0.54, 0.55),
    20: lm(0.58, 0.58),
  });
}

/** Point: index extended, middle/ring/pinky curled, thumb tucked. */
export function pointLandmarks(): Landmark[] {
  return withTips({
    4: lm(0.44, 0.68), // thumb tucked
    8: lm(0.46, 0.4), // index extended
    12: lm(0.5, 0.63), // middle curled near mcp
    16: lm(0.54, 0.64), // ring curled
    20: lm(0.58, 0.66), // pinky curled
  });
}

/** Fist: all fingers curled; thumb across but clear of the index tip. */
export function fistLandmarks(): Landmark[] {
  return withTips({
    4: lm(0.6, 0.6), // thumb over the fingers, away from index tip
    8: lm(0.46, 0.62),
    12: lm(0.5, 0.61),
    16: lm(0.54, 0.62),
    20: lm(0.58, 0.64),
  });
}

export function hand(
  landmarks: Landmark[],
  timestamp: number,
  handId = "right",
): HandObservation {
  return { handId, handedness: handId === "left" ? "left" : "right", score: 0.99, landmarks, timestamp };
}

export function frame(hands: HandObservation[], timestamp: number): FrameObservation {
  return { hands, timestamp };
}

/** Build a horizontal-swipe sequence: wrist sweeps right across `n` frames. */
export function swipeRightFrames(startTs: number, stepMs: number, n: number): FrameObservation[] {
  const frames: FrameObservation[] = [];
  for (let i = 0; i < n; i++) {
    const dx = 0.06 * i; // move right each frame
    const lms = openPalmLandmarks().map((l) => ({ ...l, x: l.x + dx }));
    const ts = startTs + i * stepMs;
    frames.push(frame([hand(lms, ts)], ts));
  }
  return frames;
}
