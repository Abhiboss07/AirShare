/**
 * Static gesture detectors.
 *
 * Purpose: classify a single frame's hand pose into per-gesture confidence
 * scores. Each detector is a pure function of one hand's landmarks (swipe, which
 * needs motion, lives in swipe.ts). Scores are scale-invariant (divided by the
 * palm span) so they hold at any distance from the camera.
 *
 * These are deliberately simple, explainable heuristics — not an ML classifier —
 * which makes them deterministic and fully unit-testable. The recognizer combines
 * them; the state machine adds temporal stability.
 */

import { HandLandmark, type Landmark, type Point2D } from "../types/gestures.js";
import {
  FINGERS,
  distance2D,
  fingerExtensionRatio,
  handScale,
  midpoint,
  normalize,
  ramp,
  subtract,
  clamp01,
} from "./geometry.js";

/** Confidence that thumb tip and index tip are pinched together. */
export function pinchConfidence(landmarks: Landmark[]): number {
  const thumb = landmarks[HandLandmark.ThumbTip];
  const index = landmarks[HandLandmark.IndexTip];
  if (!thumb || !index) return 0;
  const ratio = distance2D(thumb, index) / handScale(landmarks);
  // Pinched when the tips are within ~35% of palm span; fully open by ~70%.
  return ramp(ratio, 0.7, 0.3);
}

/** The 2D position of a pinch (the point "held"): midpoint of thumb & index. */
export function pinchPosition(landmarks: Landmark[]): Point2D {
  const thumb = landmarks[HandLandmark.ThumbTip]!;
  const index = landmarks[HandLandmark.IndexTip]!;
  return midpoint(thumb, index);
}

/** Confidence that all fingers are extended and spread (open palm). */
export function openPalmConfidence(landmarks: Landmark[]): number {
  const extensions = FINGERS.map((f) => clamp01(fingerExtensionRatio(landmarks, f) - 1) / 0.8);
  const extendedScore = extensions.reduce((a, b) => a + b, 0) / FINGERS.length;

  // Spread: average gap between adjacent fingertips, relative to palm span.
  const scale = handScale(landmarks);
  const tips = [
    landmarks[HandLandmark.IndexTip],
    landmarks[HandLandmark.MiddleTip],
    landmarks[HandLandmark.RingTip],
    landmarks[HandLandmark.PinkyTip],
  ];
  let gaps = 0;
  let count = 0;
  for (let i = 0; i < tips.length - 1; i++) {
    const a = tips[i];
    const b = tips[i + 1];
    if (a && b) {
      gaps += distance2D(a, b) / scale;
      count++;
    }
  }
  const spread = count ? ramp(gaps / count, 0.1, 0.35) : 0;
  return clamp01(0.7 * extendedScore + 0.3 * spread);
}

/** Confidence of a fist: all four fingers curled (tips near their MCPs). */
export function fistConfidence(landmarks: Landmark[]): number {
  const curls = FINGERS.map((f) => clamp01(1.15 - fingerExtensionRatio(landmarks, f)) / 0.3);
  return clamp01(curls.reduce((a, b) => a + b, 0) / FINGERS.length);
}

/**
 * Confidence of a pointing gesture: index extended while middle, ring and pinky
 * are curled. Returns the confidence and the pointing direction (index MCP→tip).
 */
export function pointConfidence(landmarks: Landmark[]): { confidence: number; direction: Point2D } {
  const indexExt = clamp01(fingerExtensionRatio(landmarks, FINGERS[0]!) - 1) / 0.6;
  const othersCurled =
    [FINGERS[1]!, FINGERS[2]!, FINGERS[3]!]
      .map((f) => clamp01(1.15 - fingerExtensionRatio(landmarks, f)) / 0.3)
      .reduce((a, b) => a + b, 0) / 3;
  const confidence = clamp01(0.6 * indexExt + 0.4 * othersCurled);

  const mcp = landmarks[HandLandmark.IndexMcp];
  const tip = landmarks[HandLandmark.IndexTip];
  const direction = mcp && tip ? normalize(subtract(tip, mcp)) : { x: 0, y: 0 };
  return { confidence, direction };
}

/** Position used to anchor a pointing gesture (the index fingertip). */
export function pointPosition(landmarks: Landmark[]): Point2D {
  const tip = landmarks[HandLandmark.IndexTip]!;
  return { x: tip.x, y: tip.y };
}
