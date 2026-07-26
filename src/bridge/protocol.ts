/**
 * Experience-bridge wire protocol (browser ↔ Node bridge, JSON over WebSocket).
 *
 * The browser is a thin client: it captures the camera, runs MediaPipe, and
 * renders. It sends raw landmark results up; the bridge sends down a curated,
 * node-tagged slice of the real event bus so the UI can animate what the actual
 * mesh is doing. Neither side runs the other's logic.
 */

import type { RawHandLandmarkerResult } from "../vision/mediapipeAdapter.js";

/** Which on-screen device a message concerns. */
export type NodeTag = "A" | "B";

// ---- Browser → bridge ------------------------------------------------------

export interface LandmarksMessage {
  type: "landmarks";
  /** Which node's vision this feeds (only "A" has a camera in the demo). */
  node: NodeTag;
  result: RawHandLandmarkerResult;
  timestamp: number;
}

export type BridgeInbound = LandmarksMessage;

// ---- Bridge → browser ------------------------------------------------------

/** Sent once on connect: the device tiles to render. */
export interface InitMessage {
  type: "init";
  nodes: { tag: NodeTag; id: string; name: string }[];
}

/**
 * A forwarded event from a node's bus. `event` is an `AirShareEventName`;
 * `payload` is its (JSON-safe) payload. The client switches on `event`.
 */
export interface EventMessage {
  type: "event";
  node: NodeTag;
  event: string;
  payload: unknown;
}

export type BridgeOutbound = InitMessage | EventMessage;

/** Events the bridge forwards to the UI (keeps the wire small and intentional). */
export const FORWARDED_EVENTS = [
  "gesture:hand-detected",
  "gesture:hand-lost",
  "gesture:pinch-start",
  "gesture:pinch-hold",
  "gesture:pinch-release",
  "gesture:point",
  "gesture:confidence",
  "hand:grab",
  "hand:target-changed",
  "hand:release",
  "transfer:started",
  "transfer:received",
  "transfer:completed",
  "transfer:metrics",
  "device:connected",
] as const;

export function isBridgeInbound(value: unknown): value is BridgeInbound {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "landmarks"
  );
}
