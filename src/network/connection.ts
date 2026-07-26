/**
 * PeerConnection — the per-peer state machine.
 *
 * Purpose: drive a single logical link with one remote device through its full
 * lifecycle: authenticated key exchange -> mutual pairing consent -> connected,
 * with heartbeat-based liveness and clean teardown. It is transport-agnostic:
 * it talks to a minimal `DuplexSocket`, so it can run over `ws` in production or
 * an in-memory pipe in tests.
 *
 * Responsibilities:
 *  - Perform the signed HELLO / HELLO_ACK exchange and derive a SecureSession.
 *  - Enforce identity binding (id == fingerprint(publicKey)) and per-message
 *    signatures + timestamp-skew checks.
 *  - Surface pairing decisions via an injected `authorize` callback (policy
 *    lives in the pairing service, not here — Dependency Inversion).
 *  - Run heartbeats and declare the peer unreachable after repeated misses.
 *
 * It deliberately owns no trust storage, no discovery and no reconnection —
 * those are composed around it by the transport and services.
 */

import {
  MessageType,
  ErrorCode,
  BROADCAST_RECEIVER,
  type AnyEnvelope,
  type Envelope,
  type HelloPayload,
} from "../types/messages.js";
import type { DeviceIdentity, Platform } from "../types/device.js";
import type { Identity } from "../security/identity.js";
import { deviceIdFor } from "../security/identity.js";
import {
  deriveSession,
  generateEphemeralKeyPair,
  type EphemeralKeyPair,
  type SecureSession,
  type SessionRole,
} from "../security/session.js";
import { computeShortAuthString } from "../security/sas.js";
import { signEnvelope, verifyEnvelopeSignature } from "../security/crypto.js";
import { MessageCodec, ProtocolError, createEnvelope } from "./protocol.js";
import { newNonce } from "../utils/ids.js";
import type { Logger } from "../utils/logger.js";

/** The minimal socket contract PeerConnection needs. */
export interface DuplexSocket {
  send(data: Buffer): void;
  close(reason?: string): void;
  onMessage(cb: (data: Buffer) => void): void;
  onClose(cb: (reason: string) => void): void;
  onError(cb: (error: Error) => void): void;
}

export type ConnectionState = "handshaking" | "pairing" | "connected" | "closed";

export interface PeerConnectionCallbacks {
  /**
   * Decide whether to trust the remote. Return true to accept pairing (the
   * implementation is expected to persist trust for unknown devices). May await
   * user interaction. Throwing or returning false rejects the pairing.
   */
  authorize(remote: DeviceIdentity, sas: string): Promise<boolean>;
  onConnected(remote: DeviceIdentity): void;
  onMessage(remote: DeviceIdentity, envelope: AnyEnvelope): void;
  onHeartbeat(deviceId: string, rttMs: number): void;
  onUnreachable(deviceId: string): void;
  onClosed(deviceId: string | undefined, reason: string): void;
}

export interface PeerConnectionOptions {
  role: SessionRole;
  identity: Identity;
  localDevice: DeviceIdentity;
  socket: DuplexSocket;
  codec: MessageCodec;
  logger: Logger;
  callbacks: PeerConnectionCallbacks;
  heartbeat: { intervalMs: number; timeoutMs: number; maxMissed: number };
  security: { clockSkewToleranceMs: number; verificationCodeLength: number };
  connectTimeoutMs: number;
}

export class PeerConnection {
  private state: ConnectionState = "handshaking";
  private readonly ephemeral: EphemeralKeyPair;
  private readonly nonce = newNonce();

  private remote: DeviceIdentity | undefined;
  private remoteEphemeral: string | undefined;
  private session: SecureSession | undefined;
  private sas = "";

  private localApproved = false;
  private remoteApproved = false;

  // Heartbeat state
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private pingTimeoutTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private pingSeq = 0;
  private pendingPingSeq: number | undefined;
  private pendingPingSentAt = 0;
  private missed = 0;

  constructor(private readonly opts: PeerConnectionOptions) {
    this.ephemeral = generateEphemeralKeyPair();
    opts.socket.onMessage((data) => this.handleFrame(data));
    opts.socket.onClose((reason) => this.close(`socket closed: ${reason}`));
    opts.socket.onError((err) => this.close(`socket error: ${err.message}`));
  }

  /** Device id of the peer once known (after HELLO). */
  get remoteId(): string | undefined {
    return this.remote?.id;
  }
  get currentState(): ConnectionState {
    return this.state;
  }

  /**
   * The purpose-separated entity-encryption key shared with this peer, available
   * only once the link is connected. Higher layers use it for end-to-end
   * encryption of the *object*; the transport (tx/rx) keys never leave here.
   */
  entityKey(): Buffer | undefined {
    return this.state === "connected" ? this.session?.entityKey() : undefined;
  }

  /** Begin the handshake. Initiators send HELLO immediately. */
  start(): void {
    this.handshakeTimer = setTimeout(() => {
      if (this.state !== "connected") this.close("handshake timeout");
    }, this.opts.connectTimeoutMs);

    if (this.opts.role === "initiator") {
      this.sendPlaintext(this.buildHello(MessageType.Hello));
    }
  }

  // ---- Sending ---------------------------------------------------------------

  private buildHello(type: MessageType.Hello | MessageType.HelloAck): Envelope<typeof type> {
    const payload: HelloPayload = {
      name: this.opts.localDevice.name,
      platform: this.opts.localDevice.platform,
      protocolVersion: this.opts.localDevice.protocolVersion,
      capabilities: this.opts.localDevice.capabilities as unknown as Record<string, boolean>,
      publicKey: this.opts.identity.publicKeyRaw,
      ephemeralPublicKey: this.ephemeral.publicKeyRaw,
      nonce: this.nonce,
    };
    return createEnvelope(
      this.opts.localDevice.id,
      this.remote?.id ?? BROADCAST_RECEIVER,
      type,
      payload,
    ) as Envelope<typeof type>;
  }

  private sendPlaintext(envelope: Envelope): void {
    const signed = signEnvelope(this.opts.identity, envelope);
    this.opts.socket.send(this.opts.codec.encodePlaintext(signed));
  }

  private sendEncrypted(envelope: Envelope): void {
    if (!this.session) throw new Error("cannot send encrypted frame without session");
    const signed = signEnvelope(this.opts.identity, envelope);
    this.opts.socket.send(this.opts.codec.encodeEncrypted(this.session, signed));
  }

  /** Public API for higher layers to send an application message. */
  sendAppMessage(channel: string, data: unknown): void {
    if (this.state !== "connected" || !this.remote) {
      throw new Error("connection not ready for application messages");
    }
    const env = createEnvelope(this.opts.localDevice.id, this.remote.id, MessageType.Message, {
      channel,
      data,
    });
    this.sendEncrypted(env);
  }

  // ---- Receiving -------------------------------------------------------------

  private handleFrame(data: Buffer): void {
    if (this.state === "closed") return;
    try {
      const { envelope } = this.opts.codec.decode(data, this.session);
      this.routeEnvelope(envelope);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.opts.logger.warn("dropping invalid frame", {
          code: error.code,
          reason: error.message,
        });
        if (error.code === ErrorCode.UnsupportedVersion) this.close("protocol version mismatch");
      } else {
        this.opts.logger.error("frame handling error", {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  private routeEnvelope(envelope: AnyEnvelope): void {
    switch (envelope.type) {
      case MessageType.Hello:
      case MessageType.HelloAck:
        this.onHello(envelope as Envelope<MessageType.Hello>);
        return;
      default:
        break;
    }

    // Everything past the handshake requires an authenticated envelope.
    if (!this.remote || !this.session) {
      this.opts.logger.warn("message before session established, dropping", {
        type: envelope.type,
      });
      return;
    }
    if (!this.verifyAuthenticity(envelope)) return;

    switch (envelope.type) {
      case MessageType.PairAccept:
        this.remoteApproved = true;
        this.maybeConnected();
        return;
      case MessageType.PairReject:
        this.close(`pairing rejected by peer: ${envelope.payload.reason}`);
        return;
      case MessageType.Ping:
        this.sendEncrypted(
          createEnvelope(this.opts.localDevice.id, this.remote.id, MessageType.Pong, {
            seq: envelope.payload.seq,
            echoTimestamp: envelope.timestamp,
          }),
        );
        return;
      case MessageType.Pong:
        this.onPong(envelope.payload.seq, envelope.payload.echoTimestamp);
        return;
      case MessageType.Error:
        this.opts.logger.warn("peer reported error", {
          code: envelope.payload.code,
          detail: envelope.payload.detail,
        });
        return;
      case MessageType.Message:
      case MessageType.TransferStart:
      case MessageType.TransferEnd:
        if (this.state === "connected") this.opts.callbacks.onMessage(this.remote, envelope);
        return;
      default:
        return;
    }
  }

  /** Verify signature, sender identity and timestamp freshness. */
  private verifyAuthenticity(envelope: AnyEnvelope): boolean {
    if (!this.remote) return false;
    if (envelope.sender !== this.remote.id) {
      this.opts.logger.warn("sender id mismatch, dropping", { sender: envelope.sender });
      return false;
    }
    const skew = Math.abs(Date.now() - envelope.timestamp);
    if (skew > this.opts.security.clockSkewToleranceMs) {
      this.opts.logger.warn("message timestamp outside skew tolerance, dropping", { skew });
      return false;
    }
    if (!verifyEnvelopeSignature(envelope, this.remote.publicKey)) {
      this.opts.logger.warn("signature verification failed, dropping", { type: envelope.type });
      return false;
    }
    return true;
  }

  private onHello(envelope: Envelope<MessageType.Hello>): void {
    if (this.session) {
      this.opts.logger.warn("duplicate HELLO ignored");
      return;
    }
    const payload = envelope.payload;

    // Bind the claimed id to the presented public key, then verify the
    // envelope signature with that key. Together these prove the peer holds the
    // private key for the id it claims.
    if (deviceIdFor(payload.publicKey) !== envelope.sender) {
      this.close("identity binding failed (id != fingerprint(publicKey))");
      return;
    }
    if (!verifyEnvelopeSignature(envelope, payload.publicKey)) {
      this.close("HELLO signature invalid");
      return;
    }

    this.remote = {
      id: envelope.sender,
      name: payload.name,
      publicKey: payload.publicKey,
      platform: payload.platform as Platform,
      protocolVersion: payload.protocolVersion,
      capabilities: { messaging: true, ...payload.capabilities },
    };
    this.remoteEphemeral = payload.ephemeralPublicKey;

    // Responder replies with its own HELLO_ACK before deriving the session.
    if (this.opts.role === "responder" && envelope.type === MessageType.Hello) {
      this.sendPlaintext(this.buildHello(MessageType.HelloAck));
    }

    this.deriveSessionKeys();
    this.beginPairing();
  }

  private deriveSessionKeys(): void {
    if (!this.remoteEphemeral) throw new Error("missing remote ephemeral key");
    const initiatorEph =
      this.opts.role === "initiator" ? this.ephemeral.publicKeyRaw : this.remoteEphemeral;
    const responderEph =
      this.opts.role === "initiator" ? this.remoteEphemeral : this.ephemeral.publicKeyRaw;

    this.session = deriveSession({
      role: this.opts.role,
      ourEphemeralPrivate: this.ephemeral.privateKey,
      peerEphemeralPublicRaw: this.remoteEphemeral,
      initiatorEphemeralPublicRaw: initiatorEph,
      responderEphemeralPublicRaw: responderEph,
    });
    this.sas = computeShortAuthString(
      initiatorEph,
      responderEph,
      this.opts.security.verificationCodeLength,
    );
  }

  private beginPairing(): void {
    if (!this.remote) return;
    this.state = "pairing";
    // Ask policy whether to trust this peer. Trusted devices resolve instantly;
    // unknown ones may await user approval.
    this.opts.callbacks
      .authorize(this.remote, this.sas)
      .then((approved) => {
        if (this.state === "closed") return;
        if (approved) {
          this.localApproved = true;
          this.sendEncrypted(
            createEnvelope(this.opts.localDevice.id, this.remote!.id, MessageType.PairAccept, {
              name: this.opts.localDevice.name,
            }),
          );
          this.maybeConnected();
        } else {
          this.sendEncrypted(
            createEnvelope(this.opts.localDevice.id, this.remote!.id, MessageType.PairReject, {
              reason: "not approved",
            }),
          );
          this.close("pairing not approved locally");
        }
      })
      .catch((error: unknown) => {
        this.opts.logger.error("authorize callback failed", {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this.close("authorization error");
      });
  }

  private maybeConnected(): void {
    if (this.state === "connected" || this.state === "closed") return;
    if (!(this.localApproved && this.remoteApproved) || !this.remote) return;
    this.state = "connected";
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.startHeartbeat();
    this.opts.callbacks.onConnected(this.remote);
  }

  // ---- Heartbeat -------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => this.sendPing(), this.opts.heartbeat.intervalMs);
    // Do not keep the process alive purely for heartbeats.
    this.heartbeatTimer.unref?.();
  }

  private sendPing(): void {
    if (this.state !== "connected" || !this.remote || !this.session) return;
    this.pingSeq += 1;
    this.pendingPingSeq = this.pingSeq;
    this.pendingPingSentAt = Date.now();
    this.sendEncrypted(
      createEnvelope(this.opts.localDevice.id, this.remote.id, MessageType.Ping, {
        seq: this.pingSeq,
      }),
    );
    this.pingTimeoutTimer = setTimeout(
      () => this.onPingTimeout(this.pingSeq),
      this.opts.heartbeat.timeoutMs,
    );
    this.pingTimeoutTimer.unref?.();
  }

  private onPong(seq: number, echoTimestamp: number): void {
    if (seq !== this.pendingPingSeq) return;
    if (this.pingTimeoutTimer) clearTimeout(this.pingTimeoutTimer);
    this.pendingPingSeq = undefined;
    this.missed = 0;
    const rtt = Date.now() - echoTimestamp;
    void this.pendingPingSentAt;
    if (this.remote) this.opts.callbacks.onHeartbeat(this.remote.id, rtt);
  }

  private onPingTimeout(seq: number): void {
    if (seq !== this.pendingPingSeq) return;
    this.pendingPingSeq = undefined;
    this.missed += 1;
    if (this.missed >= this.opts.heartbeat.maxMissed) {
      if (this.remote) this.opts.callbacks.onUnreachable(this.remote.id);
      this.close("heartbeat timeout");
    }
  }

  // ---- Teardown --------------------------------------------------------------

  close(reason: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pingTimeoutTimer) clearTimeout(this.pingTimeoutTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    try {
      this.opts.socket.close(reason);
    } catch {
      /* already closed */
    }
    this.opts.callbacks.onClosed(this.remote?.id, reason);
  }
}
