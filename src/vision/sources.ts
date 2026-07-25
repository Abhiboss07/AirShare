/**
 * Landmark sources.
 *
 * Purpose: define where hand landmarks come from, behind one interface, so the
 * VisionEngine is agnostic to capture. Phase 2 ships:
 *  - `ManualLandmarkSource`  — push frames explicitly (deterministic tests/demo)
 *  - `TimedLandmarkSource`   — replay a recorded sequence at a fixed rate
 *  - `MediaPipeLandmarkSource` (mediapipeAdapter.ts) — real camera + MediaPipe
 *
 * The engine never knows which one it is talking to — that is the whole point of
 * keeping capture/ML swappable.
 */

import type { FrameObservation } from "../types/gestures.js";

export interface LandmarkSource {
  onFrame(cb: (frame: FrameObservation) => void): void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export abstract class BaseLandmarkSource implements LandmarkSource {
  private cb: ((frame: FrameObservation) => void) | undefined;

  onFrame(cb: (frame: FrameObservation) => void): void {
    this.cb = cb;
  }
  protected emit(frame: FrameObservation): void {
    this.cb?.(frame);
  }
  abstract start(): Promise<void> | void;
  abstract stop(): Promise<void> | void;
}

/** Push-driven source: the caller decides exactly when each frame is delivered. */
export class ManualLandmarkSource extends BaseLandmarkSource {
  start(): void {
    /* nothing to do — frames are pushed via emitFrame */
  }
  stop(): void {
    /* no-op */
  }
  /** Deliver one frame synchronously. */
  emitFrame(frame: FrameObservation): void {
    this.emit(frame);
  }
}

/** Replay a fixed sequence of frames at `intervalMs`, optionally looping. */
export class TimedLandmarkSource extends BaseLandmarkSource {
  private timer: NodeJS.Timeout | undefined;
  private index = 0;

  constructor(
    private readonly frames: FrameObservation[],
    private readonly intervalMs = 33,
    private readonly loop = false,
  ) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.index >= this.frames.length) {
        if (this.loop) this.index = 0;
        else {
          this.stop();
          return;
        }
      }
      const frame = this.frames[this.index++];
      if (frame) this.emit(frame);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
