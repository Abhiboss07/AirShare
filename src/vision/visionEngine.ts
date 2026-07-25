/**
 * VisionEngine — the perception orchestrator.
 *
 * Purpose: turn a stream of raw hand landmarks into stable, high-level gesture
 * events on the shared EventBus. It owns one pipeline (smoother + state machine)
 * per tracked hand, so multiple hands are handled simultaneously and
 * independently, and it manages hand appearance/disappearance lifecycle.
 *
 * Boundaries (by design):
 *  - It knows NOTHING about networking, clipboard or files.
 *  - It talks to capture/ML only through the `LandmarkSource` interface.
 *  - It communicates outward ONLY by emitting `gesture:*` / `vision:*` events.
 * This is what lets the vision and networking layers evolve independently and
 * meet only on the bus (Phase 5 will consume these events to trigger transfers).
 *
 * Dependencies: IEventBus, LandmarkSource, VisionConfig, Logger.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { FrameObservation, HandObservation } from "../types/gestures.js";
import type { VisionConfig } from "./config.js";
import type { LandmarkSource } from "./sources.js";
import {
  EmaSmoother,
  NoopSmoother,
  OneEuroSmoother,
  type LandmarkSmoother,
} from "./smoothing.js";
import { HandStateMachine, type HandGestureEvent } from "./handStateMachine.js";

interface HandPipeline {
  smoother: LandmarkSmoother;
  machine: HandStateMachine;
  lastObs: HandObservation | undefined;
  lastSeen: number;
  handedness: HandObservation["handedness"];
}

export class VisionEngine {
  private readonly pipelines = new Map<string, HandPipeline>();
  private running = false;

  constructor(
    private readonly eventBus: IEventBus,
    private readonly source: LandmarkSource,
    private readonly config: VisionConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.source.onFrame((frame) => this.handleFrame(frame));
    await this.source.start();
    this.logger.info("vision engine started");
    this.eventBus.emit("vision:started", {});
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.source.stop();
    const now = this.latestTimestamp();
    for (const [handId, pipeline] of this.pipelines) {
      this.flushLost(handId, pipeline, now);
    }
    this.pipelines.clear();
    this.logger.info("vision engine stopped");
    this.eventBus.emit("vision:stopped", {});
  }

  /** Number of hands currently tracked (for diagnostics/tests). */
  get trackedHands(): number {
    return this.pipelines.size;
  }

  private handleFrame(frame: FrameObservation): void {
    if (!this.running) return;
    const seen = new Set<string>();

    for (const obs of frame.hands) {
      seen.add(obs.handId);
      let pipeline = this.pipelines.get(obs.handId);
      if (!pipeline) {
        pipeline = this.createPipeline(obs);
        this.pipelines.set(obs.handId, pipeline);
        this.logger.debug("hand detected", { handId: obs.handId });
        this.eventBus.emit("gesture:hand-detected", {
          handId: obs.handId,
          handedness: obs.handedness,
        });
      }

      const smoothed = pipeline.smoother.push(obs.landmarks, obs.timestamp);
      const smoothedObs: HandObservation = { ...obs, landmarks: smoothed };
      for (const ev of pipeline.machine.update(smoothedObs)) {
        this.forward(obs.handId, ev);
      }
      pipeline.lastObs = smoothedObs;
      pipeline.lastSeen = obs.timestamp;
    }

    // Reap hands that have not been seen within the timeout.
    for (const [handId, pipeline] of this.pipelines) {
      if (seen.has(handId)) continue;
      if (frame.timestamp - pipeline.lastSeen > this.config.handLostTimeoutMs) {
        this.flushLost(handId, pipeline, frame.timestamp);
        this.pipelines.delete(handId);
      }
    }
  }

  private flushLost(handId: string, pipeline: HandPipeline, now: number): void {
    for (const ev of pipeline.machine.finalize(now, pipeline.lastObs)) {
      this.forward(handId, ev);
    }
    this.logger.debug("hand lost", { handId });
    this.eventBus.emit("gesture:hand-lost", { handId });
  }

  private createPipeline(obs: HandObservation): HandPipeline {
    return {
      smoother: this.createSmoother(),
      machine: new HandStateMachine(this.config.stateMachine),
      lastObs: undefined,
      lastSeen: obs.timestamp,
      handedness: obs.handedness,
    };
  }

  private createSmoother(): LandmarkSmoother {
    const s = this.config.smoothing;
    switch (s.algorithm) {
      case "ema":
        return new EmaSmoother(s.emaAlpha);
      case "one-euro":
        return new OneEuroSmoother(s.oneEuro.minCutoff, s.oneEuro.beta, s.oneEuro.dCutoff);
      case "none":
        return new NoopSmoother();
      default:
        return new NoopSmoother();
    }
  }

  private latestTimestamp(): number {
    let max = 0;
    for (const p of this.pipelines.values()) max = Math.max(max, p.lastSeen);
    return max || Date.now();
  }

  /** Translate an internal per-hand gesture event to a bus event. */
  private forward(handId: string, ev: HandGestureEvent): void {
    switch (ev.kind) {
      case "pinch-start":
        this.eventBus.emit("gesture:pinch-start", {
          handId,
          position: ev.position,
          confidence: ev.confidence,
        });
        return;
      case "pinch-hold":
        this.eventBus.emit("gesture:pinch-hold", {
          handId,
          position: ev.position,
          durationMs: ev.durationMs,
        });
        return;
      case "pinch-release":
        this.eventBus.emit("gesture:pinch-release", {
          handId,
          position: ev.position,
          heldMs: ev.heldMs,
        });
        return;
      case "open-palm":
        this.eventBus.emit("gesture:open-palm", { handId, confidence: ev.confidence });
        return;
      case "point":
        this.eventBus.emit("gesture:point", {
          handId,
          position: ev.position,
          direction: ev.direction,
          confidence: ev.confidence,
        });
        return;
      case "swipe":
        if (ev.direction === "left") {
          this.eventBus.emit("gesture:swipe-left", { handId, velocity: ev.velocity });
        } else {
          this.eventBus.emit("gesture:swipe-right", { handId, velocity: ev.velocity });
        }
        return;
      case "holding-changed":
        this.eventBus.emit("gesture:holding-changed", { handId, holding: ev.holding });
        return;
      case "confidence":
        this.eventBus.emit("gesture:confidence", {
          handId,
          type: ev.type,
          confidence: ev.confidence,
        });
        return;
      default:
        return;
    }
  }
}
