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

/**
 * Resolves aim against the set of currently-connected devices, optionally
 * filtered by a capability predicate (e.g. "device supports files"). This is the
 * dynamic resolver the mesh uses by default: a lone connected peer is chosen
 * outright; with several peers the first that passes the predicate wins.
 *
 * The 3D pointing-ray path — projecting the `point` gesture's direction onto a
 * spatial map of devices — plugs in here once devices carry positions; the
 * interface (`hand`, `TargetContext.direction`) already reserves the inputs.
 */
export class RegistryTargetResolver implements TargetResolver {
  constructor(
    /** Ids of devices currently eligible as targets (e.g. connected peers). */
    private readonly candidates: () => string[],
    /** Optional gate: only devices for which this returns true are chosen. */
    private readonly eligible: (deviceId: string) => boolean = () => true,
  ) {}

  resolve(hand: VirtualHand, _context: TargetContext): string | undefined {
    void hand;
    void _context;
    const ids = this.candidates().filter((id) => this.eligible(id));
    return ids[0];
  }
}
