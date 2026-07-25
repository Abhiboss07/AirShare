import { describe, it, expect } from "vitest";
import {
  pinchConfidence,
  openPalmConfidence,
  fistConfidence,
  pointConfidence,
} from "../../src/vision/detectors.js";
import { GestureRecognizer } from "../../src/vision/gestureRecognizer.js";
import { GestureType } from "../../src/types/gestures.js";
import {
  openPalmLandmarks,
  pinchLandmarks,
  pointLandmarks,
  fistLandmarks,
  neutralLandmarks,
} from "./fixtures.js";

describe("static detectors", () => {
  it("scores a pinch high and an open palm low for the pinch pose", () => {
    const lms = pinchLandmarks();
    expect(pinchConfidence(lms)).toBeGreaterThan(0.8);
    expect(openPalmConfidence(lms)).toBeLessThan(0.5);
  });

  it("scores an open palm high and a pinch low for the open-palm pose", () => {
    const lms = openPalmLandmarks();
    expect(openPalmConfidence(lms)).toBeGreaterThan(0.6);
    expect(pinchConfidence(lms)).toBeLessThan(0.3);
  });

  it("scores pointing high with a plausible upward direction", () => {
    const lms = pointLandmarks();
    const { confidence, direction } = pointConfidence(lms);
    expect(confidence).toBeGreaterThan(0.6);
    expect(direction.y).toBeLessThan(0); // pointing up (smaller y)
  });

  it("scores a fist high and a pinch not-highest", () => {
    const lms = fistLandmarks();
    expect(fistConfidence(lms)).toBeGreaterThan(0.7);
  });
});

describe("GestureRecognizer", () => {
  const rec = new GestureRecognizer(0.5);
  it("classifies each canonical pose correctly", () => {
    expect(rec.classify(pinchLandmarks()).type).toBe(GestureType.Pinch);
    expect(rec.classify(openPalmLandmarks()).type).toBe(GestureType.OpenPalm);
    expect(rec.classify(pointLandmarks()).type).toBe(GestureType.Point);
    expect(rec.classify(fistLandmarks()).type).toBe(GestureType.Fist);
  });

  it("reports None for a relaxed, gesture-less hand", () => {
    expect(rec.classify(neutralLandmarks()).type).toBe(GestureType.None);
  });
});
