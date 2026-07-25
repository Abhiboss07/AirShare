/**
 * mDNS / DNS-SD device discovery.
 *
 * Purpose: advertise this node on the local network and discover peers with
 * zero manual IP entry (AirDrop-style). Publishes a `_<serviceType>._tcp`
 * service whose TXT record carries the device identity, and browses for the
 * same service type, emitting `device:found` / `device:lost` on the event bus.
 *
 * Responsibilities: presence broadcast, peer browsing, duplicate/self
 * filtering, cheap identity-binding sanity check. It does NOT connect or trust
 * anyone — that is the transport/pairing layer's job.
 *
 * Dependencies: bonjour-service (mDNS), EventBus, Logger. Guarded so that an
 * environment without multicast degrades gracefully instead of crashing.
 */

import BonjourPkg from "bonjour-service";
import type { IEventBus } from "../events/eventBus.js";

// bonjour-service is an `export =` CJS module: derive instance types from the
// exported classes rather than importing them as (non-existent) type names.
type Bonjour = InstanceType<typeof BonjourPkg>;
type Service = InstanceType<typeof BonjourPkg.Service>;
type Browser = InstanceType<typeof BonjourPkg.Browser>;
import type { Logger } from "../utils/logger.js";
import type { DiscoveryConfig } from "../config/types.js";
import type { DeviceIdentity, DeviceAddress, Platform } from "../types/device.js";
import { deviceIdFor } from "../security/identity.js";

export interface IDiscoveryService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DiscoveryDeps {
  config: DiscoveryConfig;
  logger: Logger;
  eventBus: IEventBus;
  /** Our own identity and the port our transport listens on. */
  localIdentity: DeviceIdentity;
  localPort: number;
}

interface AdvertisedTxt {
  id: string;
  name: string;
  pk: string;
  pv: string;
  caps: string;
  plat: string;
}

export class MdnsDiscoveryService implements IDiscoveryService {
  private bonjour: Bonjour | undefined;
  private published: Service | undefined;
  private browser: Browser | undefined;
  /** Maps mDNS service fqdn -> deviceId so we can resolve `down` events. */
  private readonly serviceToDevice = new Map<string, string>();

  constructor(private readonly deps: DiscoveryDeps) {}

  async start(): Promise<void> {
    try {
      this.bonjour = new BonjourPkg();
      this.publishSelf();
      this.browsePeers();
      this.deps.logger.info("discovery started", {
        service: this.deps.config.serviceType,
        port: this.deps.localPort,
      });
    } catch (error) {
      // No multicast (containers/CI): keep running, just without auto-discovery.
      this.deps.logger.warn("discovery unavailable, continuing without mDNS", {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private publishSelf(): void {
    const { localIdentity, localPort, config } = this.deps;
    const txt: AdvertisedTxt = {
      id: localIdentity.id,
      name: localIdentity.name,
      pk: localIdentity.publicKey,
      pv: String(localIdentity.protocolVersion),
      caps: JSON.stringify(localIdentity.capabilities),
      plat: localIdentity.platform,
    };
    this.published = this.bonjour!.publish({
      name: `${localIdentity.name}-${localIdentity.id.slice(0, 8)}`,
      type: config.serviceType,
      port: localPort,
      txt: txt as unknown as Record<string, string>,
    });
  }

  private browsePeers(): void {
    this.browser = this.bonjour!.find({ type: this.deps.config.serviceType });
    this.browser.on("up", (service: Service) => this.onServiceUp(service));
    this.browser.on("down", (service: Service) => this.onServiceDown(service));
  }

  private onServiceUp(service: Service): void {
    const identity = this.parseIdentity(service);
    if (!identity) return;

    // Ignore our own advertisement.
    if (identity.id === this.deps.localIdentity.id) return;

    // Cheap anti-spoof: the id must be the fingerprint of the public key.
    // The authoritative check happens again during the handshake.
    if (deviceIdFor(identity.publicKey) !== identity.id) {
      this.deps.logger.warn("discovered device with mismatched id/key, ignoring", {
        id: identity.id,
      });
      return;
    }

    const address = this.pickAddress(service);
    if (!address) {
      this.deps.logger.debug("discovered device with no usable address", { id: identity.id });
      return;
    }

    this.serviceToDevice.set(service.fqdn, identity.id);
    this.deps.logger.debug("device found", { id: identity.id, name: identity.name });
    this.deps.eventBus.emit("device:found", { identity, address });
  }

  private onServiceDown(service: Service): void {
    const deviceId = this.serviceToDevice.get(service.fqdn);
    if (!deviceId) return;
    this.serviceToDevice.delete(service.fqdn);
    this.deps.logger.debug("device lost", { id: deviceId });
    this.deps.eventBus.emit("device:lost", { deviceId });
  }

  private parseIdentity(service: Service): DeviceIdentity | undefined {
    const txt = service.txt as Partial<AdvertisedTxt> | undefined;
    if (!txt?.id || !txt.pk || !txt.name) return undefined;
    let capabilities: Record<string, boolean> = { messaging: true };
    try {
      if (txt.caps) capabilities = JSON.parse(txt.caps) as Record<string, boolean>;
    } catch {
      /* keep default */
    }
    return {
      id: txt.id,
      name: txt.name,
      publicKey: txt.pk,
      platform: (txt.plat as Platform) ?? "unknown",
      protocolVersion: Number(txt.pv ?? "1"),
      capabilities: { messaging: true, ...capabilities },
    };
  }

  private pickAddress(service: Service): DeviceAddress | undefined {
    const addresses = service.addresses ?? [];
    const ipv4 = addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    const host = ipv4 ?? addresses[0] ?? service.referer?.address ?? service.host;
    if (!host) return undefined;
    return { host, port: service.port };
  }

  async stop(): Promise<void> {
    this.browser?.stop();
    this.browser = undefined;
    await new Promise<void>((resolve) => {
      if (!this.published) {
        resolve();
        return;
      }
      this.bonjour?.unpublishAll(() => resolve());
    });
    this.bonjour?.destroy();
    this.bonjour = undefined;
    this.serviceToDevice.clear();
    this.deps.logger.info("discovery stopped");
  }
}
