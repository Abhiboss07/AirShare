/**
 * WebSocket transport.
 *
 * Purpose: own the actual sockets. Runs a WebSocket server so peers can dial in,
 * dials out to discovered peers, and wraps each socket in a PeerConnection.
 * Translates connection-lifecycle callbacks into event-bus events and keeps the
 * authoritative map of live connections (with deterministic de-duplication when
 * two peers dial each other simultaneously).
 *
 * Why WebSocket (not Socket.IO): we need full control over binary framing for
 * future file/stream transfer and a custom crypto handshake; `ws` gives a lean
 * binary channel without Socket.IO's connection-level heartbeat/reconnect that
 * we would otherwise have to work around. Reconnection and heartbeat are
 * implemented at the application layer where they can be crypto-aware.
 *
 * Dependencies: ws, PeerConnection, MessageCodec, EventBus, Logger.
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";
import { PeerConnection, type DuplexSocket, type PeerConnectionCallbacks } from "./connection.js";
import { MessageCodec } from "./protocol.js";
import type { Identity } from "../security/identity.js";
import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { AirShareConfig } from "../config/types.js";
import type { DeviceIdentity, DeviceAddress, RemoteDevice } from "../types/device.js";
import type { AnyEnvelope } from "../types/messages.js";

/** Policy hook implemented by the pairing service. */
export interface PairingAuthorizer {
  authorize(remote: DeviceIdentity, sas: string): Promise<boolean>;
}

/**
 * Transport contract the rest of the app depends on. `WebSocketTransport` is the
 * Phase-1 implementation; a future `WebRtcTransport` (for low-latency media
 * streaming) can implement the same interface and be swapped in at the
 * composition root without changing services. PeerConnection is already
 * transport-neutral (it speaks `DuplexSocket`), so a new transport only needs to
 * provide sockets and dial/listen plumbing.
 */
export interface ITransport {
  readonly port: number;
  start(): Promise<number>;
  stop(): Promise<void>;
  connect(address: DeviceAddress, expectedId?: string): void;
  sendTo(deviceId: string, channel: string, data: unknown): boolean;
  isConnected(deviceId: string): boolean;
  connectedDeviceIds(): string[];
}

interface ManagedConnection {
  connection: PeerConnection;
  role: "initiator" | "responder";
  address: DeviceAddress | undefined;
}

/** Adapts a `ws` WebSocket to the transport-neutral DuplexSocket contract. */
class WsSocketAdapter implements DuplexSocket {
  constructor(private readonly ws: WebSocket) {}
  send(data: Buffer): void {
    this.ws.send(data, { binary: true });
  }
  close(_reason?: string): void {
    void _reason;
    try {
      this.ws.close();
    } catch {
      this.ws.terminate();
    }
  }
  onMessage(cb: (data: Buffer) => void): void {
    this.ws.on("message", (data: RawData) => cb(toBuffer(data)));
  }
  onClose(cb: (reason: string) => void): void {
    this.ws.on("close", (code: number) => cb(`code ${code}`));
  }
  onError(cb: (error: Error) => void): void {
    this.ws.on("error", (error: Error) => cb(error));
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

export class WebSocketTransport implements ITransport {
  private server: WebSocketServer | undefined;
  private boundPort = 0;
  private readonly codec: MessageCodec;
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly pending = new Set<ManagedConnection>();
  /** Guards against parallel dials to the same expected device. */
  private readonly dialing = new Set<string>();

  constructor(
    private readonly config: AirShareConfig,
    private readonly identity: Identity,
    private readonly localDevice: DeviceIdentity,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly authorizer: PairingAuthorizer,
  ) {
    this.codec = new MessageCodec(config.network.maxFrameBytes);
  }

  /** The port the server actually bound to (resolves ephemeral port 0). */
  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.config.network.host,
        port: this.config.network.port,
        maxPayload: this.config.network.maxFrameBytes,
      });
      server.on("connection", (ws) => this.onIncoming(ws));
      server.on("error", (error) => {
        this.eventBus.emit("error", { scope: "transport", error });
        reject(error);
      });
      server.on("listening", () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.config.network.port;
        this.logger.info("transport listening", { port: this.boundPort });
        resolve(this.boundPort);
      });
      this.server = server;
    });
  }

  private onIncoming(ws: WebSocket): void {
    const managed = this.createConnection(new WsSocketAdapter(ws), "responder", undefined);
    managed.connection.start();
  }

  /** Dial a peer. `expectedId` (when known) prevents duplicate parallel dials. */
  connect(address: DeviceAddress, expectedId?: string): void {
    if (expectedId) {
      if (expectedId === this.localDevice.id) return;
      if (this.connections.has(expectedId) || this.dialing.has(expectedId)) return;
      this.dialing.add(expectedId);
      this.eventBus.emit("device:connecting", { deviceId: expectedId });
    }
    const url = `ws://${address.host}:${address.port}`;
    const ws = new WebSocket(url, { handshakeTimeout: this.config.network.connectTimeoutMs });

    const cleanupDial = (): void => {
      if (expectedId) this.dialing.delete(expectedId);
    };

    ws.on("open", () => {
      cleanupDial();
      const managed = this.createConnection(new WsSocketAdapter(ws), "initiator", address);
      managed.connection.start();
    });
    ws.on("error", (error) => {
      cleanupDial();
      this.logger.warn("dial failed", { url, error });
      this.eventBus.emit("error", { scope: "transport.dial", error });
    });
  }

  private createConnection(
    socket: DuplexSocket,
    role: "initiator" | "responder",
    address: DeviceAddress | undefined,
  ): ManagedConnection {
    const managed: ManagedConnection = { connection: undefined as never, role, address };
    const callbacks: PeerConnectionCallbacks = {
      authorize: (remote, sas) => this.authorizer.authorize(remote, sas),
      onConnected: (remote) => this.onConnected(managed, remote),
      onMessage: (remote, envelope) => this.onMessage(remote, envelope),
      onHeartbeat: (deviceId, rttMs) => this.eventBus.emit("heartbeat:ok", { deviceId, rttMs }),
      onUnreachable: (deviceId) => {
        this.eventBus.emit("heartbeat:timeout", { deviceId });
        this.eventBus.emit("device:unreachable", { deviceId });
      },
      onClosed: (deviceId, reason) => this.onClosed(managed, deviceId, reason),
    };
    const connection = new PeerConnection({
      role,
      identity: this.identity,
      localDevice: this.localDevice,
      socket,
      codec: this.codec,
      logger: this.logger.child(`peer:${role}`),
      callbacks,
      heartbeat: this.config.heartbeat,
      security: {
        clockSkewToleranceMs: this.config.security.clockSkewToleranceMs,
        verificationCodeLength: this.config.security.verificationCodeLength,
      },
      connectTimeoutMs: this.config.network.connectTimeoutMs,
    });
    managed.connection = connection;
    this.pending.add(managed);
    return managed;
  }

  private onConnected(managed: ManagedConnection, remote: DeviceIdentity): void {
    this.pending.delete(managed);
    const existing = this.connections.get(remote.id);
    if (existing && existing !== managed) {
      // Both peers dialed each other. Deterministically keep the connection
      // initiated by the numerically-smaller device id so both sides agree.
      if (this.isPrimary(managed, remote.id)) {
        existing.connection.close("superseded by primary connection");
      } else {
        managed.connection.close("duplicate connection");
        return;
      }
    }
    this.connections.set(remote.id, managed);

    const device: RemoteDevice = {
      identity: remote,
      address: managed.address ?? { host: "unknown", port: 0 },
      status: "connected",
      trusted: true,
      lastSeen: Date.now(),
    };
    this.logger.info("device connected", { id: remote.id, name: remote.name });
    this.eventBus.emit("device:connected", { device });
  }

  private isPrimary(managed: ManagedConnection, remoteId: string): boolean {
    const initiatorId = managed.role === "initiator" ? this.localDevice.id : remoteId;
    const smaller = this.localDevice.id < remoteId ? this.localDevice.id : remoteId;
    return initiatorId === smaller;
  }

  private onMessage(remote: DeviceIdentity, envelope: AnyEnvelope): void {
    this.eventBus.emit("message:received", { from: remote.id, envelope });
  }

  private onClosed(managed: ManagedConnection, deviceId: string | undefined, reason: string): void {
    this.pending.delete(managed);
    if (!deviceId) return;
    const current = this.connections.get(deviceId);
    if (current === managed) {
      // A live connection dropped.
      this.connections.delete(deviceId);
      this.eventBus.emit("device:disconnected", { deviceId, reason });
    } else if (current === undefined) {
      // Handshake/pairing failed before this link was ever registered.
      this.eventBus.emit("device:disconnected", { deviceId, reason });
    }
    // else: a superseded duplicate connection closing — stay silent.
  }

  /** Send an application message to a connected device. Returns false if not connected. */
  sendTo(deviceId: string, channel: string, data: unknown): boolean {
    const managed = this.connections.get(deviceId);
    if (!managed) return false;
    managed.connection.sendAppMessage(channel, data);
    return true;
  }

  isConnected(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  connectedDeviceIds(): string[] {
    return [...this.connections.keys()];
  }

  async stop(): Promise<void> {
    for (const managed of this.connections.values()) managed.connection.close("transport stopping");
    for (const managed of this.pending) managed.connection.close("transport stopping");
    this.connections.clear();
    this.pending.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = undefined;
    this.logger.info("transport stopped");
  }
}
