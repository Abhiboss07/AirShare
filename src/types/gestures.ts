/**
 * Vision / gesture shared vocabulary.
 *
 * Purpose: the common language the vision subsystem speaks. Lives in `types/`
 * (the shared contract layer) rather than in `vision/` so that other layers can
 * *consume* gesture events without depending on the vision implementation — the
 * same way `network/` depends on `types/messages.ts`, not vice versa.
 *
 * This file contains NO logic and NO camera/ML dependency — only data shapes.
 */

/** A single normalized landmark. x,y are image-normalized [0,1]; z is relative depth. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/** 2D point in normalized image space. */
export interface Point2D {
  x: number;
  y: number;
}

export type Handedness = "left" | "right" | "unknown";

/**
 * The 21 MediaPipe Hands landmark indices. Detectors reference these names
 * instead of magic array indices.
 */
export enum HandLandmark {
  Wrist = 0,
  ThumbCmc = 1,
  ThumbMcp = 2,
  ThumbIp = 3,
  ThumbTip = 4,
  IndexMcp = 5,
  IndexPip = 6,
  IndexDip = 7,
  IndexTip = 8,
  MiddleMcp = 9,
  MiddlePip = 10,
  MiddleDip = 11,
  MiddleTip = 12,
  RingMcp = 13,
  RingPip = 14,
  RingDip = 15,
  RingTip = 16,
  PinkyMcp = 17,
  PinkyPip = 18,
  PinkyDip = 19,
  PinkyTip = 20,
}

export const HAND_LANDMARK_COUNT = 21;

/**
 * One hand as observed in a single frame. This is the boundary type between the
 * capture/ML layer (which produces it) and the gesture logic (which consumes
 * it). A `LandmarkSource` — MediaPipe-backed or synthetic — emits these.
 */
export interface HandObservation {
  /** Stable-ish id for tracking a hand across frames (Phase 2: by handedness). */
  handId: string;
  handedness: Handedness;
  /** Model confidence that this is a hand, [0,1]. */
  score: number;
  /** Exactly HAND_LANDMARK_COUNT landmarks, in HandLandmark index order. */
  landmarks: Landmark[];
  /** Capture timestamp, epoch ms. */
  timestamp: number;
}

/** A batch of hands seen in one video frame (0..N hands). */
export interface FrameObservation {
  hands: HandObservation[];
  timestamp: number;
}

/** The gestures Phase 2 understands. */
export enum GestureType {
  None = "NONE",
  OpenPalm = "OPEN_PALM",
  Pinch = "PINCH",
  Point = "POINT",
  Fist = "FIST",
}

/** A raw per-frame classification for one hand. */
export interface GestureClassification {
  type: GestureType;
  confidence: number;
  /** Per-gesture scores, for debugging / hysteresis. */
  scores: Partial<Record<GestureType, number>>;
}

/**
 * Minimal "holding" state for Phase 2 (a sustained pinch). Phase 3's Virtual
 * Object System expands this into a full IDLE→SELECTED→HELD→MOVING→… lifecycle.
 */
export type HoldingState = "idle" | "held";
