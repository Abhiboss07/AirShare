import { describe, it, expect } from "vitest";
import {
  mapMediaPipeResult,
  type RawHandLandmarkerResult,
} from "../../src/vision/mediapipeAdapter.js";
import { openPalmLandmarks } from "./fixtures.js";

function raw(landmarks: { x: number; y: number; z: number }[], label: string): RawHandLandmarkerResult {
  return {
    landmarks: [landmarks],
    handedness: [[{ categoryName: label, score: 0.97 }]],
  };
}

describe("mapMediaPipeResult", () => {
  it("maps a MediaPipe result into a FrameObservation", () => {
    const lms = openPalmLandmarks();
    const frame = mapMediaPipeResult(raw(lms, "Right"), 4242);
    expect(frame.timestamp).toBe(4242);
    expect(frame.hands).toHaveLength(1);
    expect(frame.hands[0]!.handedness).toBe("right");
    expect(frame.hands[0]!.handId).toBe("right");
    expect(frame.hands[0]!.score).toBeCloseTo(0.97);
    expect(frame.hands[0]!.landmarks).toHaveLength(21);
  });

  it("skips hands with the wrong landmark count", () => {
    const frame = mapMediaPipeResult({ landmarks: [[{ x: 0, y: 0, z: 0 }]] }, 1);
    expect(frame.hands).toHaveLength(0);
  });

  it("labels unknown handedness and falls back to an index id", () => {
    const frame = mapMediaPipeResult({ landmarks: [openPalmLandmarks()] }, 1);
    expect(frame.hands[0]!.handedness).toBe("unknown");
    expect(frame.hands[0]!.handId).toBe("hand-0");
  });
});
