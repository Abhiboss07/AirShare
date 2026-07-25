/**
 * TargetResolver — decides which device a hand is aiming at.
 *
 * Purpose: turning a pointing gesture into a destination device is its own
 * concern, so it lives behind an interface. Phase 3 ships a static resolver (for
 * tests/demo). Phase 5 will implement a resolver that combines the `point`
 * gesture's direction with the DeviceRegistry (nearest device along the ray).
 * The runtime depends only on the interface.
 */

import type { VirtualHand } from "../types/transfer.js";
import type { Point2D } from "../types/gestures.js";

export interface TargetContext {
  direction?: Point2D;
  position?: Point2D;
}

export interface TargetResolver {
  resolve(hand: VirtualHand, context: TargetContext): string | undefined;
}

/** Always resolves to a fixed device id. Useful for tests and single-target UX. */
export class StaticTargetResolver implements TargetResolver {
  constructor(private readonly deviceId: string | undefined) {}
  resolve(): string | undefined {
    return this.deviceId;
  }
}
