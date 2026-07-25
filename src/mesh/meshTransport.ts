/**
 * MeshTransferTransport — the real cross-device transport.
 *
 * Purpose: implement `ITransferTransport` over the Phase-1 secure mesh. A
 * `TransferEnvelope` is sent as a channelled message to the target device; the
 * peer processes it and replies with an ack on the ack channel. Request/response
 * is correlated by `transferId`, with a timeout. Because it rides the Phase-1
 * `MESSAGE` channel, every byte is already AES-256-GCM encrypted by the
 * authenticated session — the entity-level cipher is defence in depth.
 *
 * It also measures latency: RTT (single source clock) and destination-side
 * processing time (single dest clock) are exact; the network split is an
 * estimate because device clocks are not synchronized. Metrics are emitted as
 * `transfer:metrics`.
 *
 * The runtime uses only `send()`/`onReceive()`; streaming methods inherit the
 * NotImplemented defaults from `BaseTransferTransport` (Phase 5/6 territory).
 */

import { BaseTransferTransport, type ReceiveHandler } from "../transfer/transport.js";
import type { TransferAck, TransferEnvelope } from "../types/transfer.js";
import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { MeshMessenger } from "./messenger.js";
import { createDeferred, type Deferred } from "../utils/async.js";

export const CHANNEL_TRANSFER = "airshare/transfer";
export const CHANNEL_ACK = "airshare/transfer-ack";

export interface MeshTransportOptions {
  /** How long to wait for a peer ack before failing, in ms. */
  ackTimeoutMs: number;
}

export const DEFAULT_MESH_TRANSPORT_OPTIONS: MeshTransportOptions = {
  ackTimeoutMs: 10_000,
};

/** Wire shapes carried inside the encrypted MESSAGE channel. */
interface TransferWire {
  envelope: TransferEnvelope;
  sentAt: number;
}
interface AckWire extends TransferAck {
  sentAt: number;
  receivedAt: number;
  processedAt: number;
}

interface Pending {
  deferred: Deferred<TransferAck>;
  sentAt: number;
  envelope: TransferEnvelope;
  timer: NodeJS.Timeout;
}

export class MeshTransferTransport extends BaseTransferTransport {
  private handler: ReceiveHandler | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly messenger: MeshMessenger,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly options: MeshTransportOptions = DEFAULT_MESH_TRANSPORT_OPTIONS,
  ) {
    super();
    // Always listen: acks correlate to our sends; transfers go to the handler.
    this.messenger.onMessage((from, channel, data) => this.onMessage(from, channel, data));
  }

  override onReceive(handler: ReceiveHandler): void {
    this.handler = handler;
  }

  override send(envelope: TransferEnvelope): Promise<TransferAck> {
    const sentAt = Date.now();
    const wire: TransferWire = { envelope, sentAt };
    const delivered = this.messenger.sendTo(envelope.target, CHANNEL_TRANSFER, wire);
    if (!delivered) {
      return Promise.resolve({
        transferId: envelope.transferId,
        accepted: false,
        reason: "target not connected",
      });
    }

    const deferred = createDeferred<TransferAck>();
    const timer = setTimeout(() => {
      this.pending.delete(envelope.transferId);
      deferred.resolve({ transferId: envelope.transferId, accepted: false, reason: "ack timeout" });
    }, this.options.ackTimeoutMs);
    timer.unref?.();
    this.pending.set(envelope.transferId, { deferred, sentAt, envelope, timer });
    return deferred.promise;
  }

  private onMessage(from: string, channel: string, data: unknown): void {
    if (channel === CHANNEL_TRANSFER) {
      void this.handleIncoming(from, data as TransferWire);
    } else if (channel === CHANNEL_ACK) {
      this.handleAck(data as AckWire);
    }
  }

  private async handleIncoming(from: string, wire: TransferWire): Promise<void> {
    const receivedAt = Date.now();
    const { envelope, sentAt } = wire;
    let ack: TransferAck;
    if (!this.handler) {
      ack = { transferId: envelope.transferId, accepted: false, reason: "no receiver attached" };
    } else {
      try {
        ack = await this.handler(envelope);
      } catch (error) {
        ack = {
          transferId: envelope.transferId,
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const ackWire: AckWire = { ...ack, sentAt, receivedAt, processedAt: Date.now() };
    this.messenger.sendTo(from, CHANNEL_ACK, ackWire);
  }

  private handleAck(ack: AckWire): void {
    const pending = this.pending.get(ack.transferId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(ack.transferId);

    const ackAt = Date.now();
    const rttMs = ackAt - pending.sentAt;
    const processingMs = Math.max(0, ack.processedAt - ack.receivedAt);
    const estimatedNetworkMs = Math.max(0, Math.round((rttMs - processingMs) / 2));
    this.eventBus.emit("transfer:metrics", {
      transferId: ack.transferId,
      entityId: pending.envelope.entity.id,
      targetDeviceId: pending.envelope.target,
      sentAt: pending.sentAt,
      ackAt,
      rttMs,
      processingMs,
      estimatedNetworkMs,
      bytes: pending.envelope.entity.payload.length,
    });
    this.logger.debug("transfer acked", { transferId: ack.transferId, rttMs, processingMs });

    pending.deferred.resolve({
      transferId: ack.transferId,
      accepted: ack.accepted,
      ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
    });
  }
}
