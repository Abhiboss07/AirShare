/**
 * ConnectionManager — auto-connect and reconnection.
 *
 * Purpose: turn discovery + lifecycle events into dial decisions. Trusted
 * devices are connected automatically when discovered; connections that drop or
 * time out are retried with capped exponential backoff for as long as the peer
 * remains discovered. This is what makes links survive Wi-Fi blips without
 * manual intervention.
 *
 * Responsibilities: auto-connect policy, backoff scheduling, cancellation when
 * a device reconnects or disappears.
 *
 * Dependencies: EventBus, ITransport, DeviceRegistry, ReconnectConfig,
 * DiscoveryConfig, Logger. Uses computeBackoff (pure) for delay math.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { ITransport } from "../network/transport.js";
import type { DeviceRegistry } from "./deviceRegistry.js";
import type { DiscoveryConfig, ReconnectConfig } from "../config/types.js";
import { computeBackoff } from "../utils/async.js";

interface RetryState {
  attempt: number;
  timer: NodeJS.Timeout;
}

export class ConnectionManager {
  private readonly retries = new Map<string, RetryState>();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly transport: ITransport,
    private readonly registry: DeviceRegistry,
    private readonly reconnect: ReconnectConfig,
    private readonly discovery: DiscoveryConfig,
    private readonly logger: Logger,
  ) {}

  attach(): void {
    this.eventBus.on("device:found", (e) => this.onFound(e.identity.id));
    this.eventBus.on("device:connected", (e) => this.onConnected(e.device.identity.id));
    this.eventBus.on("device:disconnected", (e) => this.scheduleReconnect(e.deviceId));
    this.eventBus.on("device:unreachable", (e) => this.scheduleReconnect(e.deviceId));
    this.eventBus.on("device:lost", (e) => this.cancel(e.deviceId));
  }

  private async onFound(deviceId: string): Promise<void> {
    if (!this.discovery.autoConnectTrusted) return;
    if (this.transport.isConnected(deviceId)) return;
    const record = this.registry.get(deviceId);
    if (!record?.trusted) return;
    this.logger.debug("auto-connecting trusted device", { id: deviceId });
    this.transport.connect(record.address, deviceId);
  }

  private onConnected(deviceId: string): void {
    this.cancel(deviceId);
  }

  private scheduleReconnect(deviceId: string): void {
    if (!this.reconnect.enabled) return;
    const record = this.registry.get(deviceId);
    // Only chase devices we trust and can still see on the network.
    if (!record?.trusted) return;
    if (record.status === "lost") return;
    if (this.transport.isConnected(deviceId)) return;

    const prev = this.retries.get(deviceId);
    const attempt = prev ? prev.attempt + 1 : 0;
    if (this.reconnect.maxAttempts > 0 && attempt >= this.reconnect.maxAttempts) {
      this.logger.warn("giving up reconnecting", { id: deviceId, attempt });
      this.cancel(deviceId);
      return;
    }
    if (prev) clearTimeout(prev.timer);

    const delayMs = computeBackoff(attempt, this.reconnect);
    const timer = setTimeout(() => this.attemptReconnect(deviceId), delayMs);
    timer.unref?.();
    this.retries.set(deviceId, { attempt, timer });
    this.logger.debug("reconnect scheduled", { id: deviceId, attempt, delayMs });
  }

  private attemptReconnect(deviceId: string): void {
    const record = this.registry.get(deviceId);
    if (!record || !record.trusted || record.status === "lost") {
      this.cancel(deviceId);
      return;
    }
    if (this.transport.isConnected(deviceId)) {
      this.cancel(deviceId);
      return;
    }
    this.logger.debug("reconnecting", { id: deviceId });
    this.transport.connect(record.address, deviceId);
    // If this attempt fails, a fresh disconnect/unreachable event reschedules.
    // Guard against silent failure by re-arming from here as well.
    this.scheduleReconnect(deviceId);
  }

  private cancel(deviceId: string): void {
    const state = this.retries.get(deviceId);
    if (state) {
      clearTimeout(state.timer);
      this.retries.delete(deviceId);
    }
  }

  stop(): void {
    for (const state of this.retries.values()) clearTimeout(state.timer);
    this.retries.clear();
  }
}
