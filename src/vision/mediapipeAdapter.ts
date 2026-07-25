/**
 * MediaPipe adapter.
 *
 * Purpose: bridge Google MediaPipe Hands output into our `HandObservation`
 * boundary type. We deliberately do NOT import `@mediapipe/tasks-vision` here:
 * that package targets a browser/WASM+GL runtime and owns the camera loop, which
 * is environment-specific. Instead the caller runs MediaPipe in whatever runtime
 * they have (browser, Electron renderer, native binding) and feeds us the raw
 * result objects; we map + emit them. This keeps the core dependency-free and
 * unit-testable, and means the same engine works no matter how landmarks are
 * produced.
 *
 * `mapMediaPipeResult` is a pure function (tested). `MediaPipeLandmarkSource`
 * wraps it as a `LandmarkSource` you drive with `pushResult()` from your capture
 * loop.
 *
 * Wiring sketch (browser/Electron), for reference — lives outside this package:
 *   const landmarker = await HandLandmarker.createFromOptions(vision, {
 *     baseOptions: { modelAssetPath: "hand_landmarker.task" },
 *     numHands: 2, runningMode: "VIDEO",
 *   });
 *   function loop(t) {
 *     const res = landmarker.detectForVideo(videoEl, t);
 *     source.pushResult(res, performance.timeOrigin + t);
 *     requestAnimationFrame(loop);
 *   }
 */

import type { FrameObservation, Handedness, Landmark } from "../types/gestures.js";
import { HAND_LANDMARK_COUNT } from "../types/gestures.js";
import { BaseLandmarkSource } from "./sources.js";

/** Minimal structural mirror of MediaPipe's result — avoids a hard dependency. */
export interface RawLandmark {
  x: number;
  y: number;
  z: number;
}
export interface RawCategory {
  categoryName?: string;
  displayName?: string;
  score?: number;
}
export interface RawHandLandmarkerResult {
  landmarks: RawLandmark[][];
  handedness?: RawCategory[][];
}

function toHandedness(category: RawCategory | undefined): Handedness {
  const name = (category?.categoryName ?? category?.displayName ?? "").toLowerCase();
  if (name.startsWith("left")) return "left";
  if (name.startsWith("right")) return "right";
  return "unknown";
}

/**
 * Map a MediaPipe result to a FrameObservation. Hands with the wrong landmark
 * count are skipped defensively. `handId` is the handedness label (Phase-2
 * tracking assumption: at most one left and one right hand).
 */
export function mapMediaPipeResult(
  result: RawHandLandmarkerResult,
  timestamp: number,
): FrameObservation {
  const hands = [];
  for (let i = 0; i < result.landmarks.length; i++) {
    const raw = result.landmarks[i];
    if (!raw || raw.length !== HAND_LANDMARK_COUNT) continue;
    const category = result.handedness?.[i]?.[0];
    const handedness = toHandedness(category);
    const landmarks: Landmark[] = raw.map((l) => ({ x: l.x, y: l.y, z: l.z }));
    hands.push({
      handId: handedness === "unknown" ? `hand-${i}` : handedness,
      handedness,
      score: category?.score ?? 1,
      landmarks,
      timestamp,
    });
  }
  return { hands, timestamp };
}

/**
 * A `LandmarkSource` fed by MediaPipe results from the caller's capture loop.
 * The engine treats it exactly like any other source.
 */
export class MediaPipeLandmarkSource extends BaseLandmarkSource {
  start(): void {
    /* the caller owns the capture loop and calls pushResult */
  }
  stop(): void {
    /* no-op */
  }
  pushResult(result: RawHandLandmarkerResult, timestamp: number): void {
    this.emit(mapMediaPipeResult(result, timestamp));
  }
}
