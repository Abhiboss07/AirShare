/**
 * Vision subsystem public API (Phase 2).
 *
 * The "eyes" of Air Share: it converts hand landmarks into high-level gesture
 * events on the shared EventBus and knows nothing about networking. Compose a
 * VisionEngine with any LandmarkSource (MediaPipe in production; scripted/manual
 * in tests) and subscribe to `gesture:*` events on the bus.
 */

export { VisionEngine } from "./visionEngine.js";
export {
  loadVisionConfig,
  DEFAULT_VISION_CONFIG,
  type VisionConfig,
  type PartialVisionConfig,
  type SmoothingAlgorithm,
} from "./config.js";
export {
  type LandmarkSource,
  BaseLandmarkSource,
  ManualLandmarkSource,
  TimedLandmarkSource,
} from "./sources.js";
export {
  MediaPipeLandmarkSource,
  mapMediaPipeResult,
  type RawHandLandmarkerResult,
  type RawLandmark,
  type RawCategory,
} from "./mediapipeAdapter.js";
export { GestureRecognizer } from "./gestureRecognizer.js";
export { HandStateMachine, type HandGestureEvent } from "./handStateMachine.js";
export { SwipeDetector, DEFAULT_SWIPE_OPTIONS, type SwipeOptions } from "./swipe.js";
export {
  EmaSmoother,
  OneEuroSmoother,
  NoopSmoother,
  type LandmarkSmoother,
} from "./smoothing.js";
export * as detectors from "./detectors.js";
export * as geometry from "./geometry.js";
