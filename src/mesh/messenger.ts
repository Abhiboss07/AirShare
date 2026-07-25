/**
 * MeshMessenger — the narrow messaging contract the mesh transport needs.
 *
 * Purpose: decouple the Transfer-Runtime-over-network glue from `AirShareNode`'s
 * full surface. Anything that can send channelled messages to a device, be
 * notified of incoming ones, and report new connections satisfies this. The
 * `AirShareNodeMessenger` adapter maps the Phase-1 node onto it; tests use a
 * fake. This is the only place the mesh layer touches networking.
 */

import type { AirShareNode } from "../core/airShareNode.js";
import { MessageType } from "../types/messages.js";

export interface MeshMessenger {
  readonly localDeviceId: string;
  /** Send `data` on `channel` to a connected device. Returns false if not connected. */
  sendTo(deviceId: string, channel: string, data: unknown): boolean;
  /** Subscribe to inbound channelled messages. Returns an unsubscribe fn. */
  onMessage(cb: (from: string, channel: string, data: unknown) => void): () => void;
  /** Subscribe to "a device became connected". Returns an unsubscribe fn. */
  onConnected(cb: (deviceId: string) => void): () => void;
}

/** Adapts an `AirShareNode` (Phase 1) to the MeshMessenger contract. */
export class AirShareNodeMessenger implements MeshMessenger {
  constructor(private readonly node: AirShareNode) {}

  get localDeviceId(): string {
    return this.node.identityInfo.id;
  }

  sendTo(deviceId: string, channel: string, data: unknown): boolean {
    return this.node.sendTo(deviceId, channel, data);
  }

  onMessage(cb: (from: string, channel: string, data: unknown) => void): () => void {
    return this.node.on("message:received", ({ from, envelope }) => {
      if (envelope.type !== MessageType.Message) return;
      const payload = envelope.payload as { channel: string; data: unknown };
      cb(from, payload.channel, payload.data);
    });
  }

  onConnected(cb: (deviceId: string) => void): () => void {
    return this.node.on("device:connected", ({ device }) => cb(device.identity.id));
  }
}
