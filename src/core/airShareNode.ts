/**
 * AirShareNode — composition root and public facade.
 *
 * Purpose: wire every module together (Dependency Injection happens here and
 * only here) and expose a small, stable API to embedders/UI. This is the object
 * a desktop app, CLI or test creates.
 *
 * Responsibilities: bootstrap identity + storage, build the event bus, trust,
 * pairing, transport, discovery, registry and reconnection, then start/stop the
 * whole system cleanly.
 *
 * Future integration: later phases add services (clipboard sync, file transfer,
 * gesture bridge) by constructing them here and subscribing to the same bus —
 * no existing module needs to change.
 */

import { loadConfig } from "../config/config.js";
import type { AirShareConfig, PartialConfig } from "../config/types.js";
import { createLogger, type Logger, type LogSink } from "../utils/logger.js";
import { EventBus, type IEventBus } from "../events/eventBus.js";
import { Identity } from "../security/identity.js";
import { TrustManager } from "../security/trust.js";
import { JsonStorageProvider } from "../storage/jsonStorage.js";
import type { StorageProvider } from "../storage/types.js";
import { WebSocketTransport, type ITransport } from "../network/transport.js";
import { MdnsDiscoveryService, type IDiscoveryService } from "../network/discovery.js";
import { DeviceRegistry } from "../services/deviceRegistry.js";
import { PairingService } from "../services/pairingService.js";
import { ConnectionManager } from "../services/connectionManager.js";
import { PROTOCOL_VERSION } from "../types/messages.js";
import type { DeviceIdentity, RemoteDevice, TrustedDeviceRecord } from "../types/device.js";
import type {
  AirShareEventListener,
  AirShareEventName,
} from "../types/events.js";

export interface AirShareNodeOptions {
  config?: PartialConfig;
  /** Inject a custom log sink (tests capture output; default writes stdout). */
  logSink?: LogSink;
  /** Inject an alternate storage provider (e.g. SQLite) or in-memory for tests. */
  storage?: StorageProvider;
  /** Disable mDNS (tests dial directly); defaults to enabled. */
  enableDiscovery?: boolean;
}

export class AirShareNode {
  readonly config: AirShareConfig;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly storage: StorageProvider;
  private readonly enableDiscovery: boolean;

  private identity!: Identity;
  private localDevice!: DeviceIdentity;
  private trust!: TrustManager;
  private transport!: ITransport;
  private discovery: IDiscoveryService | undefined;
  private registry!: DeviceRegistry;
  private pairing!: PairingService;
  private connectionManager!: ConnectionManager;
  private started = false;

  constructor(options: AirShareNodeOptions = {}) {
    this.config = loadConfig(options.config);
    this.logger = options.logSink
      ? createLogger("air-share", this.config.logLevel, options.logSink)
      : createLogger("air-share", this.config.logLevel);
    this.eventBus = new EventBus(this.logger.child("events"));
    this.storage = options.storage ?? new JsonStorageProvider(this.config.dataDir);
    this.enableDiscovery = options.enableDiscovery ?? true;
  }

  /** The event bus, for advanced consumers. Prefer `on`/`off` below. */
  get events(): IEventBus {
    return this.eventBus;
  }
  get identityInfo(): DeviceIdentity {
    return this.localDevice;
  }
  get port(): number {
    return this.transport.port;
  }

  on<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): () => void {
    return this.eventBus.on(event, listener);
  }
  off<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): void {
    this.eventBus.off(event, listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.storage.init();
    this.identity = await this.loadOrCreateIdentity();
    this.localDevice = this.buildLocalDevice();
    this.trust = new TrustManager(this.storage.trust);

    this.pairing = new PairingService(
      this.trust,
      this.eventBus,
      this.logger.child("pairing"),
      this.config.security,
    );
    this.transport = new WebSocketTransport(
      this.config,
      this.identity,
      this.localDevice,
      this.eventBus,
      this.logger.child("transport"),
      this.pairing,
    );
    this.registry = new DeviceRegistry(this.eventBus, this.trust, this.logger.child("registry"));
    this.connectionManager = new ConnectionManager(
      this.eventBus,
      this.transport,
      this.registry,
      this.config.reconnect,
      this.config.discovery,
      this.logger.child("reconnect"),
    );

    // Subscribe before anything can emit.
    this.registry.attach();
    this.connectionManager.attach();

    const port = await this.transport.start();

    if (this.enableDiscovery) {
      this.discovery = new MdnsDiscoveryService({
        config: this.config.discovery,
        logger: this.logger.child("discovery"),
        eventBus: this.eventBus,
        localIdentity: this.localDevice,
        localPort: port,
      });
      await this.discovery.start();
    }

    this.started = true;
    this.logger.info("Air Share node started", {
      id: this.localDevice.id,
      name: this.localDevice.name,
      port,
    });
    this.eventBus.emit("node:started", { identity: this.localDevice });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.discovery?.stop();
    this.connectionManager.stop();
    await this.transport.stop();
    this.eventBus.emit("node:stopped", {});
    this.eventBus.removeAll();
    this.logger.info("Air Share node stopped");
  }

  // ---- Public queries / actions ---------------------------------------------

  listDevices(): RemoteDevice[] {
    return this.registry.list();
  }
  listTrusted(): Promise<TrustedDeviceRecord[]> {
    return this.trust.list();
  }
  revokeTrust(deviceId: string): Promise<void> {
    return this.trust.revoke(deviceId);
  }

  /** Manually dial a peer by address (bypasses discovery). */
  connectTo(host: string, port: number, expectedId?: string): void {
    this.transport.connect({ host, port }, expectedId);
  }

  /** Send an application message to a connected device. */
  sendTo(deviceId: string, channel: string, data: unknown): boolean {
    return this.transport.sendTo(deviceId, channel, data);
  }

  /** Device ids of currently-connected peers. */
  connectedDeviceIds(): string[] {
    return this.transport.connectedDeviceIds();
  }

  /**
   * The shared end-to-end entity-encryption key for a connected peer (or
   * undefined). Used by the transfer layer to encrypt the object itself,
   * independently of the transport session.
   */
  entityKeyFor(deviceId: string): Buffer | undefined {
    return this.transport.entityKeyFor(deviceId);
  }

  private async loadOrCreateIdentity(): Promise<Identity> {
    const material = await this.storage.identity.load();
    if (material) {
      this.logger.debug("loaded existing identity");
      return Identity.fromKeyMaterial(material);
    }
    const identity = Identity.generate();
    await this.storage.identity.save(identity.export());
    this.logger.info("generated new device identity", { id: identity.deviceId });
    return identity;
  }

  private buildLocalDevice(): DeviceIdentity {
    return {
      id: this.identity.deviceId,
      name: this.config.deviceName,
      publicKey: this.identity.publicKeyRaw,
      platform: this.config.platform,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { messaging: true },
    };
  }
}
