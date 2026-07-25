/**
 * Transfer transport boundary.
 *
 * Purpose: the seam between the Transfer Runtime and the *network*. The runtime
 * hands a fully-serialized `TransferEnvelope` to an `ITransferTransport` and
 * awaits an ack — it neither knows nor cares whether that travels over the
 * Phase-1 WebSocket mesh, WebRTC, or an in-memory loopback.
 *
 * The interface is deliberately **streaming-ready** from day one: `send()` moves
 * a whole entity, while `sendStream()`/`cancel()`/`pause()`/`resume()` exist for
 * large files and live media. Transports that don't support streaming yet throw
 * `NotImplementedError` (via `BaseTransferTransport`) — the architecture already
 * accommodates it, so no rewrite is needed when Phase 5/6 turn it on.
 */

import type { TransferAck, TransferEnvelope } from "../types/transfer.js";

export type ReceiveHandler = (envelope: TransferEnvelope) => Promise<TransferAck>;

/** Metadata describing a streamed transfer (payload arrives as chunks). */
export interface StreamMeta {
  transferId: string;
  envelope: TransferEnvelope;
  totalBytes?: number;
}

export interface ITransferTransport {
  /** Deliver a whole entity to `envelope.target`. Resolves with the peer's ack. */
  send(envelope: TransferEnvelope): Promise<TransferAck>;
  /** Register the handler invoked when an envelope arrives for this device. */
  onReceive(handler: ReceiveHandler): void;

  // ---- Streaming-ready surface (may throw NotImplementedError for now) ------
  /** Stream a large/live payload as chunks. */
  sendStream(meta: StreamMeta, chunks: AsyncIterable<Uint8Array>): Promise<TransferAck>;
  /** Cancel an in-flight or queued transfer. */
  cancel(transferId: string): Promise<void>;
  /** Pause an in-flight transfer (flow control). */
  pause(transferId: string): Promise<void>;
  /** Resume a paused transfer. */
  resume(transferId: string): Promise<void>;
}

export class NotImplementedError extends Error {
  override readonly name = "NotImplementedError";
  constructor(feature: string) {
    super(`${feature} is not implemented by this transport yet`);
  }
}

/**
 * Base class providing throwing defaults for the streaming surface, so a
 * transport only has to implement `send`/`onReceive` today while still
 * satisfying the full, future-proof interface.
 */
export abstract class BaseTransferTransport implements ITransferTransport {
  abstract send(envelope: TransferEnvelope): Promise<TransferAck>;
  abstract onReceive(handler: ReceiveHandler): void;

  sendStream(_meta: StreamMeta, _chunks: AsyncIterable<Uint8Array>): Promise<TransferAck> {
    void _meta;
    void _chunks;
    return Promise.reject(new NotImplementedError("sendStream"));
  }
  cancel(_transferId: string): Promise<void> {
    void _transferId;
    return Promise.reject(new NotImplementedError("cancel"));
  }
  pause(_transferId: string): Promise<void> {
    void _transferId;
    return Promise.reject(new NotImplementedError("pause"));
  }
  resume(_transferId: string): Promise<void> {
    void _transferId;
    return Promise.reject(new NotImplementedError("resume"));
  }
}

/**
 * An in-process switch that routes envelopes between `InMemoryTransferTransport`
 * endpoints by device id. Handy for tests, demos and single-machine multi-node
 * development. (The real cross-device path is `MeshTransferTransport`.)
 */
export class InMemoryTransferSwitch {
  private readonly handlers = new Map<string, ReceiveHandler>();

  connect(deviceId: string, handler: ReceiveHandler): void {
    this.handlers.set(deviceId, handler);
  }
  disconnect(deviceId: string): void {
    this.handlers.delete(deviceId);
  }

  async route(envelope: TransferEnvelope): Promise<TransferAck> {
    const handler = this.handlers.get(envelope.target);
    if (!handler) {
      return { transferId: envelope.transferId, accepted: false, reason: "target not reachable" };
    }
    return handler(envelope);
  }
}

export class InMemoryTransferTransport extends BaseTransferTransport {
  constructor(
    private readonly deviceId: string,
    private readonly sw: InMemoryTransferSwitch,
  ) {
    super();
  }

  onReceive(handler: ReceiveHandler): void {
    this.sw.connect(this.deviceId, handler);
  }
  send(envelope: TransferEnvelope): Promise<TransferAck> {
    return this.sw.route(envelope);
  }
}
