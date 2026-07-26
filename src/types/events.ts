/**
 * Event catalogue for the internal event bus.
 *
 * Purpose: give every module a typed, decoupled way to react to lifecycle
 * changes without holding references to each other. Services subscribe here
 * rather than calling one another directly (SOLID: depend on the bus, not
 * concrete collaborators).
 *
 * Extension point: later phases add `transfer:*`, `gesture:*`, `clipboard:*`
 * events by extending `AirShareEventMap`.
 */

import type { RemoteDevice, DeviceIdentity, DeviceAddress } from "./device.js";
import type { AnyEnvelope, ErrorCode } from "./messages.js";
import type { GestureType, Handedness, HoldingState, Point2D } from "./gestures.js";
import type {
  EntityState,
  EntityType,
  TransferableEntity,
  TransferAction,
  TransferMetrics,
  VirtualHand,
} from "./transfer.js";

export interface PairRequestEvent {
  device: RemoteDevice;
  verificationCode: string;
  /** Resolve pairing: approve stores trust and completes the session. */
  accept: () => void;
  reject: (reason?: string) => void;
}

/**
 * The full event map. Keys are event names; values are payload types.
 * `AirShareEventMap[K]` is the single argument passed to listeners of `K`.
 */
export interface AirShareEventMap {
  // Discovery
  "device:found": { identity: DeviceIdentity; address: DeviceAddress };
  "device:lost": { deviceId: string };
  // Connection lifecycle
  "device:connecting": { deviceId: string };
  "device:connected": { device: RemoteDevice };
  "device:disconnected": { deviceId: string; reason: string };
  "device:unreachable": { deviceId: string };
  "device:status": { deviceId: string; device: RemoteDevice };
  // Pairing
  "pair:request": PairRequestEvent;
  "pair:accepted": { device: RemoteDevice };
  "pair:rejected": { deviceId: string; reason: string };
  // Messaging
  "message:received": { from: string; envelope: AnyEnvelope };
  // Heartbeat
  "heartbeat:timeout": { deviceId: string };
  "heartbeat:ok": { deviceId: string; rttMs: number };
  // Diagnostics
  "error": { scope: string; code?: ErrorCode; error: Error };
  // Node lifecycle
  "node:started": { identity: DeviceIdentity };
  "node:stopped": Record<string, never>;

  // --- Vision / gesture (Phase 2) -------------------------------------------
  // Emitted by the vision subsystem. The networking layer neither produces nor
  // requires these; they travel over the same bus so future phases can react.
  "vision:started": Record<string, never>;
  "vision:stopped": Record<string, never>;
  "gesture:hand-detected": { handId: string; handedness: Handedness };
  "gesture:hand-lost": { handId: string };
  "gesture:pinch-start": { handId: string; position: Point2D; confidence: number };
  "gesture:pinch-hold": { handId: string; position: Point2D; durationMs: number };
  "gesture:pinch-release": { handId: string; position: Point2D; heldMs: number };
  "gesture:open-palm": { handId: string; confidence: number };
  "gesture:point": { handId: string; position: Point2D; direction: Point2D; confidence: number };
  "gesture:swipe-left": { handId: string; velocity: number };
  "gesture:swipe-right": { handId: string; velocity: number };
  "gesture:holding-changed": { handId: string; holding: HoldingState };
  /** Throttled stream of the current best gesture + confidence, per hand. */
  "gesture:confidence": { handId: string; type: GestureType; confidence: number };

  // --- Transfer Runtime (Phase 3) -------------------------------------------
  // Emitted by the entity/transfer runtime. The vision layer never sees these;
  // the networking layer consumes them in Phase 5 via ITransferTransport.
  "entity:created": { entity: TransferableEntity };
  "entity:state": { entityId: string; type: EntityType; from: EntityState; to: EntityState };
  "entity:destroyed": { entityId: string };
  "hand:grab": { handId: string; entityId: string; entityType: EntityType };
  "hand:release": { handId: string; entityId: string; targetDeviceId?: string };
  "hand:target-changed": { handId: string; targetDeviceId?: string | undefined };
  "hand:updated": { hand: VirtualHand };
  "transfer:started": { transferId: string; entityId: string; action: TransferAction; targetDeviceId: string };
  "transfer:progress": { transferId: string; ratio: number };
  "transfer:received": { entityId: string; type: EntityType; from: string };
  "transfer:completed": { transferId: string; entityId: string; targetDeviceId?: string };
  "transfer:failed": { transferId: string; entityId: string; reason: string };
  /** A queued transfer is being retried after a failure (scheduler). */
  "transfer:retry": { transferId: string; attempt: number; reason: string };
  "transfer:metrics": TransferMetrics;
  "capabilities:negotiated": { deviceId: string; capabilities: string[] };
}

export type AirShareEventName = keyof AirShareEventMap;
export type AirShareEventListener<K extends AirShareEventName> = (
  payload: AirShareEventMap[K],
) => void;
