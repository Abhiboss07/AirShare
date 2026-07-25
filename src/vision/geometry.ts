/**
 * Landmark geometry — pure vector math.
 *
 * Purpose: the numeric foundation every gesture detector shares. All functions
 * are pure and side-effect free, so they are trivially unit-testable without a
 * camera or ML model. Detectors reference these helpers instead of open-coding
 * vector arithmetic.
 *
 * Coordinate note: landmarks are image-normalized ([0,1]); x grows to the right
 * of the (possibly mirrored) frame, y grows downward. Detectors therefore rely
 * on *relative* distances/ratios, never absolute pixel values, so they are
 * resolution- and distance-independent.
 */

import { HandLandmark, type Landmark, type Point2D } from "../types/gestures.js";

export function distance2D(a: Landmark | Point2D, b: Landmark | Point2D): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function distance3D(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function midpoint(a: Landmark, b: Landmark): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function magnitude(v: Point2D): number {
  return Math.hypot(v.x, v.y);
}

export function normalize(v: Point2D): Point2D {
  const m = magnitude(v);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
}

/** Angle at vertex `b` formed by a-b-c, in radians [0, π]. */
export function angleBetween(a: Landmark, b: Landmark, c: Landmark): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag = magnitude(v1) * magnitude(v2);
  if (mag === 0) return 0;
  // Clamp to guard against fp drift outside acos domain.
  return Math.acos(Math.min(1, Math.max(-1, dot / mag)));
}

/**
 * A scale-invariant unit for a hand: the palm span (wrist → middle-finger MCP).
 * Distances are divided by this so thresholds hold regardless of how close the
 * hand is to the camera. Guarded against degenerate (zero) spans.
 */
export function handScale(landmarks: Landmark[]): number {
  const wrist = landmarks[HandLandmark.Wrist];
  const middleMcp = landmarks[HandLandmark.MiddleMcp];
  if (!wrist || !middleMcp) return 1;
  return Math.max(distance2D(wrist, middleMcp), 1e-6);
}

/** Fingertip / pip / mcp index triples for the four non-thumb fingers. */
export const FINGERS: ReadonlyArray<{ tip: HandLandmark; pip: HandLandmark; mcp: HandLandmark }> = [
  { tip: HandLandmark.IndexTip, pip: HandLandmark.IndexPip, mcp: HandLandmark.IndexMcp },
  { tip: HandLandmark.MiddleTip, pip: HandLandmark.MiddlePip, mcp: HandLandmark.MiddleMcp },
  { tip: HandLandmark.RingTip, pip: HandLandmark.RingPip, mcp: HandLandmark.RingMcp },
  { tip: HandLandmark.PinkyTip, pip: HandLandmark.PinkyPip, mcp: HandLandmark.PinkyMcp },
];

/**
 * Whether a finger is extended: its tip is meaningfully farther from the wrist
 * than its PIP joint. Returns a soft ratio (>1 ⇒ extended) so callers can score
 * confidence rather than make a hard binary call.
 */
export function fingerExtensionRatio(
  landmarks: Landmark[],
  finger: { tip: HandLandmark; pip: HandLandmark },
): number {
  const wrist = landmarks[HandLandmark.Wrist];
  const tip = landmarks[finger.tip];
  const pip = landmarks[finger.pip];
  if (!wrist || !tip || !pip) return 0;
  const pipDist = distance2D(wrist, pip);
  if (pipDist === 0) return 0;
  return distance2D(wrist, tip) / pipDist;
}

/** Clamp a value to [0,1]. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Map a value to a [0,1] confidence via a linear ramp between `zero` and `one`.
 * If one < zero the ramp is inverted (smaller input ⇒ higher confidence), which
 * is what pinch (small distance ⇒ high confidence) needs.
 */
export function ramp(value: number, zero: number, one: number): number {
  if (one === zero) return value >= one ? 1 : 0;
  return clamp01((value - zero) / (one - zero));
}
