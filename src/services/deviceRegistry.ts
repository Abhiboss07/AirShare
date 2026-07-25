/**
 * DeviceRegistry — authoritative view of known peers.
 *
 * Purpose: maintain the single source of truth for every peer's identity,
 * address and lifecycle status by reacting to network events. UI and other
 * services query the registry instead of poking the transport directly.
 *
 * Responsibilities: track discovered/connecting/connected/unreachable/lost
 * state, remember discovery addresses (needed for reconnection), stamp RTT and
 * last-seen, and re-emit a normalized `device:status` whenever a record changes.
 *
 * Dependencies: EventBus (in + out), TrustManager (trusted flag), Logger.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { TrustManager } from "../security/trust.js";
import type { DeviceAddress, RemoteDevice, DeviceStatus } from "../types/device.js";

export class DeviceRegistry {
  private readonly devices = new Map<string, RemoteDevice>();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly trust: TrustManager,
    private readonly logger: Logger,
  ) {}

  /** Subscribe to the network events that mutate device state. */
  attach(): void {
    this.eventBus.on("device:found", (e) => void this.onFound(e.identity.id, e));
    this.eventBus.on("device:lost", (e) => this.onLost(e.deviceId));
    this.eventBus.on("device:connecting", (e) => this.setStatus(e.deviceId, "connecting"));
    this.eventBus.on("device:connected", (e) => this.onConnected(e.device));
    this.eventBus.on("device:disconnected", (e) => this.setStatus(e.deviceId, "unreachable"));
    this.eventBus.on("device:unreachable", (e) => this.setStatus(e.deviceId, "unreachable"));
    this.eventBus.on("heartbeat:ok", (e) => this.onHeartbeat(e.deviceId, e.rttMs));
  }

  get(deviceId: string): RemoteDevice | undefined {
    return this.devices.get(deviceId);
  }
  list(): RemoteDevice[] {
    return [...this.devices.values()];
  }
  addressOf(deviceId: string): DeviceAddress | undefined {
    return this.devices.get(deviceId)?.address;
  }

  private async onFound(
    id: string,
    e: { identity: RemoteDevice["identity"]; address: DeviceAddress },
  ): Promise<void> {
    const trusted = await this.trust.isTrusted(id);
    const existing = this.devices.get(id);
    const record: RemoteDevice = existing
      ? { ...existing, address: e.address, lastSeen: Date.now(), trusted }
      : {
          identity: e.identity,
          address: e.address,
          status: "discovered",
          trusted,
          lastSeen: Date.now(),
        };
    this.devices.set(id, record);
    this.logger.debug("registry: device found", { id, trusted });
    this.emitStatus(record);
  }

  private onLost(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (!record) return;
    // Keep connected devices even if the mDNS record blinks; only mark lost
    // when they are not actively connected.
    if (record.status === "connected") return;
    this.setStatus(deviceId, "lost");
  }

  private onConnected(device: RemoteDevice): void {
    const existing = this.devices.get(device.identity.id);
    // Preserve a known discovery address if the transport didn't have one.
    const address =
      device.address.host === "unknown" && existing ? existing.address : device.address;
    const record: RemoteDevice = { ...device, address, lastSeen: Date.now() };
    this.devices.set(device.identity.id, record);
    this.emitStatus(record);
  }

  private onHeartbeat(deviceId: string, rttMs: number): void {
    const record = this.devices.get(deviceId);
    if (!record) return;
    const updated: RemoteDevice = {
      ...record,
      rttMs,
      lastSeen: Date.now(),
      status: "connected",
    };
    this.devices.set(deviceId, updated);
    this.emitStatus(updated);
  }

  private setStatus(deviceId: string, status: DeviceStatus): void {
    const record = this.devices.get(deviceId);
    if (!record || record.status === status) return;
    const updated: RemoteDevice = { ...record, status, lastSeen: Date.now() };
    this.devices.set(deviceId, updated);
    this.emitStatus(updated);
  }

  private emitStatus(record: RemoteDevice): void {
    this.eventBus.emit("device:status", { deviceId: record.identity.id, device: record });
  }
}
