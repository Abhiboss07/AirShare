/**
 * HandStateMachine — temporal stability & holding state for ONE hand.
 *
 * Purpose: raw per-frame classifications flicker; UIs and transfers need stable,
 * debounced, edge-triggered gestures. This machine turns a stream of frame
 * classifications into clean high-level events (pinch start/hold/release, open
 * palm, point, swipe) using hysteresis (a gesture must persist to activate and
 * to deactivate) and tracks the "holding" state that a sustained pinch implies.
 *
 * It emits nothing to the bus directly — it RETURNS events. The VisionEngine
 * tags them with the handId and forwards them. That keeps this class pure and
 * unit-testable with a scripted sequence of observations.
 */

import {
  GestureType,
  type GestureClassification,
  type HandObservation,
  type HoldingState,
  type Point2D,
} from "../types/gestures.js";
import { GestureRecognizer } from "./gestureRecognizer.js";
import { SwipeDetector, type SwipeOptions } from "./swipe.js";
import { pinchPosition, pointConfidence, pointPosition } from "./detectors.js";

export type HandGestureEvent =
  | { kind: "pinch-start"; position: Point2D; confidence: number }
  | { kind: "pinch-hold"; position: Point2D; durationMs: number }
  | { kind: "pinch-release"; position: Point2D; heldMs: number }
  | { kind: "open-palm"; confidence: number }
  | { kind: "point"; position: Point2D; direction: Point2D; confidence: number }
  | { kind: "swipe"; direction: "left" | "right"; velocity: number }
  | { kind: "holding-changed"; holding: HoldingState }
  | { kind: "confidence"; type: GestureType; confidence: number };

export interface HandStateMachineOptions {
  /**
   * Consecutive frames a gesture must hold to (de)activate. A candidate gesture
   * — including "None" — only becomes active after persisting this many frames,
   * which provides symmetric enter/exit hysteresis and kills single-frame
   * flicker.
   */
  enterFrames: number;
  /** Min confidence for a static classification to count. */
  minConfidence: number;
  /** Interval between repeated pinch-hold emissions while held, in ms. */
  holdEmitIntervalMs: number;
  /** Throttle for the continuous confidence stream, in ms. */
  confidenceIntervalMs: number;
  swipe: SwipeOptions;
  /** Flip swipe direction (mirror-image / selfie cameras). */
  mirrorSwipe: boolean;
}

export class HandStateMachine {
  private readonly recognizer: GestureRecognizer;
  private readonly swipeDetector: SwipeDetector;

  private candidate = GestureType.None;
  private candidateCount = 0;
  private active = GestureType.None;

  private pinchStartedAt = 0;
  private lastHoldEmit = 0;
  private holding: HoldingState = "idle";
  private lastConfidenceEmit = 0;

  constructor(private readonly opts: HandStateMachineOptions) {
    this.recognizer = new GestureRecognizer(opts.minConfidence);
    this.swipeDetector = new SwipeDetector(opts.swipe);
  }

  get holdingState(): HoldingState {
    return this.holding;
  }
  get activeGesture(): GestureType {
    return this.active;
  }

  update(obs: HandObservation): HandGestureEvent[] {
    const events: HandGestureEvent[] = [];
    const now = obs.timestamp;
    const raw: GestureClassification = this.recognizer.classify(obs.landmarks);

    // --- Hysteresis: debounce the raw classification into `active`. ----------
    if (raw.type === this.candidate) {
      this.candidateCount++;
    } else {
      this.candidate = raw.type;
      this.candidateCount = 1;
    }

    if (this.candidate !== this.active && this.candidateCount >= this.opts.enterFrames) {
      this.transition(this.active, this.candidate, obs, raw, now, events);
      this.active = this.candidate;
    }

    // --- Sustained pinch → holding + periodic hold events. -------------------
    if (this.active === GestureType.Pinch) {
      if (now - this.lastHoldEmit >= this.opts.holdEmitIntervalMs) {
        this.lastHoldEmit = now;
        events.push({
          kind: "pinch-hold",
          position: pinchPosition(obs.landmarks),
          durationMs: now - this.pinchStartedAt,
        });
      }
    }

    // --- Swipe (motion, independent of the static pose). ---------------------
    const swipe = this.swipeDetector.push(obs.landmarks, now);
    if (swipe) {
      const direction = this.opts.mirrorSwipe
        ? swipe.direction === "left"
          ? "right"
          : "left"
        : swipe.direction;
      events.push({ kind: "swipe", direction, velocity: swipe.velocity });
    }

    // --- Throttled confidence stream. ----------------------------------------
    if (now - this.lastConfidenceEmit >= this.opts.confidenceIntervalMs) {
      this.lastConfidenceEmit = now;
      events.push({ kind: "confidence", type: this.active, confidence: raw.confidence });
    }

    return events;
  }

  /** Handle entering/leaving gestures on a confirmed transition. */
  private transition(
    from: GestureType,
    to: GestureType,
    obs: HandObservation,
    raw: GestureClassification,
    now: number,
    events: HandGestureEvent[],
  ): void {
    // Leaving pinch → release.
    if (from === GestureType.Pinch) {
      events.push({
        kind: "pinch-release",
        position: pinchPosition(obs.landmarks),
        heldMs: now - this.pinchStartedAt,
      });
      this.setHolding("idle", events);
    }

    // Entering a gesture.
    switch (to) {
      case GestureType.Pinch: {
        this.pinchStartedAt = now;
        this.lastHoldEmit = now;
        events.push({
          kind: "pinch-start",
          position: pinchPosition(obs.landmarks),
          confidence: raw.confidence,
        });
        this.setHolding("held", events);
        break;
      }
      case GestureType.OpenPalm:
        events.push({ kind: "open-palm", confidence: raw.confidence });
        break;
      case GestureType.Point: {
        const { direction, confidence } = pointConfidence(obs.landmarks);
        events.push({
          kind: "point",
          position: pointPosition(obs.landmarks),
          direction,
          confidence,
        });
        break;
      }
      default:
        break;
    }
  }

  /** Called when the engine drops this hand: flush any release/holding change. */
  finalize(now: number, lastLandmarks: HandObservation | undefined): HandGestureEvent[] {
    const events: HandGestureEvent[] = [];
    if (this.active === GestureType.Pinch && lastLandmarks) {
      events.push({
        kind: "pinch-release",
        position: pinchPosition(lastLandmarks.landmarks),
        heldMs: now - this.pinchStartedAt,
      });
    }
    if (this.holding !== "idle") this.setHolding("idle", events);
    return events;
  }

  private setHolding(state: HoldingState, events: HandGestureEvent[]): void {
    if (this.holding === state) return;
    this.holding = state;
    events.push({ kind: "holding-changed", holding: state });
  }
}
