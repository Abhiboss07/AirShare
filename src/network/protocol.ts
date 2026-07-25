/**
 * Wire framing & envelope codec.
 *
 * Purpose: turn `Envelope` objects into bytes and back, with a one-byte frame
 * tag distinguishing plaintext handshake frames from encrypted application
 * frames. Also validates incoming envelopes so malformed/oversized/unsupported
 * messages are rejected before any handler sees them.
 *
 * Public API: `createEnvelope`, `MessageCodec`, `ProtocolError`.
 *
 * Dependencies: SecureSession (for encrypted frames). Transport-agnostic — the
 * same frames could travel over any binary channel.
 */

import {
  PROTOCOL_VERSION,
  MessageType,
  ErrorCode,
  BROADCAST_RECEIVER,
  type AnyEnvelope,
  type Envelope,
  type MessagePayloads,
} from "../types/messages.js";
import { newMessageId } from "../utils/ids.js";
import type { SecureSession } from "../security/session.js";

export enum FrameType {
  Plaintext = 0x01,
  Encrypted = 0x02,
}

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(
    message: string,
    readonly code: ErrorCode = ErrorCode.MalformedMessage,
  ) {
    super(message);
  }
}

/** Build an unsigned envelope; the caller signs it via crypto.signEnvelope. */
export function createEnvelope<T extends MessageType>(
  sender: string,
  receiver: string,
  type: T,
  payload: MessagePayloads[T],
): Envelope<T> {
  return {
    version: PROTOCOL_VERSION,
    messageId: newMessageId(),
    timestamp: Date.now(),
    sender,
    receiver,
    type,
    payload,
    signature: "",
  };
}

const VALID_TYPES = new Set<string>(Object.values(MessageType));

/** Validate the structural shape of a decoded envelope. Throws ProtocolError. */
export function validateEnvelope(value: unknown): AnyEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new ProtocolError("envelope is not an object");
  }
  const e = value as Record<string, unknown>;

  if (typeof e["version"] !== "number") throw new ProtocolError("missing version");
  if (e["version"] !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `unsupported protocol version ${String(e["version"])}`,
      ErrorCode.UnsupportedVersion,
    );
  }
  if (typeof e["messageId"] !== "string" || e["messageId"].length === 0) {
    throw new ProtocolError("missing messageId");
  }
  if (typeof e["timestamp"] !== "number") throw new ProtocolError("missing timestamp");
  if (typeof e["sender"] !== "string") throw new ProtocolError("missing sender");
  if (typeof e["receiver"] !== "string") throw new ProtocolError("missing receiver");
  if (typeof e["type"] !== "string" || !VALID_TYPES.has(e["type"])) {
    throw new ProtocolError(`unknown message type ${String(e["type"])}`);
  }
  if (typeof e["payload"] !== "object" || e["payload"] === null) {
    throw new ProtocolError("missing payload");
  }
  if (typeof e["signature"] !== "string") throw new ProtocolError("missing signature");

  return value as AnyEnvelope;
}

export interface DecodedFrame {
  frameType: FrameType;
  envelope: AnyEnvelope;
}

export class MessageCodec {
  constructor(private readonly maxFrameBytes: number) {}

  encodePlaintext(envelope: Envelope): Buffer {
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    return Buffer.concat([Buffer.from([FrameType.Plaintext]), body]);
  }

  encodeEncrypted(session: SecureSession, envelope: Envelope): Buffer {
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    return Buffer.concat([Buffer.from([FrameType.Encrypted]), session.encrypt(body)]);
  }

  /**
   * Decode a raw frame. Encrypted frames require an established session; a
   * missing session for an encrypted frame is a protocol error.
   */
  decode(data: Buffer, session: SecureSession | undefined): DecodedFrame {
    if (data.length > this.maxFrameBytes) {
      throw new ProtocolError("frame exceeds maximum size");
    }
    if (data.length < 1) throw new ProtocolError("empty frame");
    const frameType = data[0] as FrameType;
    const body = data.subarray(1);

    let jsonBytes: Buffer;
    if (frameType === FrameType.Plaintext) {
      jsonBytes = body;
    } else if (frameType === FrameType.Encrypted) {
      if (!session) throw new ProtocolError("encrypted frame before session established");
      try {
        jsonBytes = session.decrypt(body);
      } catch {
        throw new ProtocolError("failed to decrypt frame", ErrorCode.SignatureInvalid);
      }
    } else {
      throw new ProtocolError(`unknown frame type ${String(frameType)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBytes.toString("utf8"));
    } catch {
      throw new ProtocolError("frame body is not valid JSON");
    }
    return { frameType, envelope: validateEnvelope(parsed) };
  }
}

export { BROADCAST_RECEIVER };
