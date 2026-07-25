/**
 * VirtualHandRegistry — the runtime's model of the user's hands.
 *
 * Purpose: Huawei's system maintains an internal virtual-hand state; so do we.
 * Each hand tracks whether it is holding something, which entity, its
 * confidence, its intended target device and its last gesture. Crucially this
 * lives in the *transfer* layer, driven by gesture events off the bus — the
 * vision layer never knows entities exist.
 *
 * The registry is pure state + emits `hand:updated`; the TransferRuntime decides
 * what to do on grabs/releases.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Handedness } from "../types/gestures.js";
import type { VirtualHand } from "../types/transfer.js";

export class VirtualHandRegistry {
  private readonly hands = new Map<string, VirtualHand>();

  constructor(private readonly eventBus: IEventBus) {}

  ensure(handId: string, handedness: Handedness): VirtualHand {
    let hand = this.hands.get(handId);
    if (!hand) {
      hand = {
        handId,
        handedness,
        holding: false,
        confidence: 0,
        updatedAt: Date.now(),
      };
      this.hands.set(handId, hand);
      this.emit(hand);
    }
    return hand;
  }

  get(handId: string): VirtualHand | undefined {
    return this.hands.get(handId);
  }
  list(): VirtualHand[] {
    return [...this.hands.values()];
  }

  update(handId: string, patch: Partial<VirtualHand>): VirtualHand | undefined {
    const hand = this.hands.get(handId);
    if (!hand) return undefined;
    Object.assign(hand, patch, { updatedAt: Date.now() });
    this.emit(hand);
    return hand;
  }

  attachEntity(handId: string, entityId: string): void {
    this.update(handId, { holding: true, entityId });
  }
  detachEntity(handId: string): void {
    const hand = this.hands.get(handId);
    if (!hand) return;
    hand.entityId = undefined;
    this.update(handId, { holding: false });
  }
  setTarget(handId: string, targetDeviceId: string | undefined): void {
    this.update(handId, { targetDeviceId });
  }

  remove(handId: string): VirtualHand | undefined {
    const hand = this.hands.get(handId);
    this.hands.delete(handId);
    return hand;
  }

  private emit(hand: VirtualHand): void {
    this.eventBus.emit("hand:updated", { hand: { ...hand } });
  }
}
