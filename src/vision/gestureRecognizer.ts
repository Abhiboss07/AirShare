/**
 * GestureRecognizer — per-frame static classification.
 *
 * Purpose: run every static detector on one hand and pick the dominant gesture
 * with a confidence score, returning all raw scores for the state machine to use
 * for hysteresis. Motion gestures (swipe) are handled separately by the state
 * machine via SwipeDetector; this class answers "what pose is the hand in right
 * now?".
 */

import { GestureType, type GestureClassification, type Landmark } from "../types/gestures.js";
import {
  pinchConfidence,
  openPalmConfidence,
  pointConfidence,
  fistConfidence,
} from "./detectors.js";

export class GestureRecognizer {
  /** Minimum confidence for a static gesture to be reported as non-None. */
  constructor(private readonly minConfidence = 0.5) {}

  classify(landmarks: Landmark[]): GestureClassification {
    const scores: Partial<Record<GestureType, number>> = {
      [GestureType.Pinch]: pinchConfidence(landmarks),
      [GestureType.OpenPalm]: openPalmConfidence(landmarks),
      [GestureType.Point]: pointConfidence(landmarks).confidence,
      [GestureType.Fist]: fistConfidence(landmarks),
    };

    let best = GestureType.None;
    let bestScore = this.minConfidence;
    for (const [type, score] of Object.entries(scores) as [GestureType, number][]) {
      if (score > bestScore) {
        best = type;
        bestScore = score;
      }
    }

    return {
      type: best,
      confidence: best === GestureType.None ? 0 : bestScore,
      scores,
    };
  }
}
