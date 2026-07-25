/**
 * Wire message protocol.
 *
 * Purpose: define the canonical envelope every Air Share node speaks, plus the
 * Phase 1 message catalogue. The envelope is transport-agnostic — the same
 * shape flows over WebSocket today and could flow over WebRTC/QUIC later.
 *
 * Extension point: add a member to `MessageType` and a matching payload
 * interface to `MessagePayloads`; the discriminated union keeps handlers
 * exhaustive at compile time.
 */

/** Bump when the envelope shape or handshake changes incompatibly. */
export const PROTOCOL_VERSION = 1 as const;

export enum MessageType {
  // Liveness
  Ping = "PING",
  Pong = "PONG",
  // Discovery / session
  Hello = "HELLO",
  HelloAck = "HELLO_ACK",
  // Pairing
  Pair = "PAIR",
  PairAccept = "PAIR_ACCEPT",
  PairReject = "PAIR_REJECT",
  // Application
  Message = "MESSAGE",
  // Transfer lifecycle (payloads defined in later phases)
  TransferStart = "TRANSFER_START",
  TransferEnd = "TRANSFER_END",
  // Failure
  Error = "ERROR",
}

/** Application-level error codes carried by ERROR messages. */
export enum ErrorCode {
  UnsupportedVersion = "UNSUPPORTED_VERSION",
  MalformedMessage = "MALFORMED_MESSAGE",
  Unauthorized = "UNAUTHORIZED",
  SignatureInvalid = "SIGNATURE_INVALID",
  NotPaired = "NOT_PAIRED",
  Internal = "INTERNAL",
}

export interface PingPayload {
  seq: number;
}
export interface PongPayload {
  seq: number;
  /** Echo of the ping's send timestamp, so the sender can compute RTT. */
  echoTimestamp: number;
}
export interface HelloPayload {
  name: string;
  platform: string;
  protocolVersion: number;
  capabilities: Record<string, boolean>;
  /** Base64url raw Ed25519 signing key — lets the receiver verify the envelope
   *  signature and confirm the sender id is this key's fingerprint. */
  publicKey: string;
  /** Base64url X25519 ephemeral public key for this session's ECDH. */
  ephemeralPublicKey: string;
  /** Random base64url nonce, signed to prove key possession (anti-replay). */
  nonce: string;
}
export type HelloAckPayload = HelloPayload;

export interface PairPayload {
  /** Optional short numeric code shown to both users for out-of-band confirm. */
  verificationCode: string;
}
export interface PairAcceptPayload {
  name: string;
}
export interface PairRejectPayload {
  reason: string;
}
export interface GenericMessagePayload {
  channel: string;
  data: unknown;
}
export interface ErrorPayload {
  code: ErrorCode;
  detail?: string;
  /** messageId this error refers to, when applicable. */
  inReplyTo?: string;
}

/** Maps each message type to its payload shape. */
export interface MessagePayloads {
  [MessageType.Ping]: PingPayload;
  [MessageType.Pong]: PongPayload;
  [MessageType.Hello]: HelloPayload;
  [MessageType.HelloAck]: HelloAckPayload;
  [MessageType.Pair]: PairPayload;
  [MessageType.PairAccept]: PairAcceptPayload;
  [MessageType.PairReject]: PairRejectPayload;
  [MessageType.Message]: GenericMessagePayload;
  [MessageType.TransferStart]: GenericMessagePayload;
  [MessageType.TransferEnd]: GenericMessagePayload;
  [MessageType.Error]: ErrorPayload;
}

/**
 * The canonical envelope. `signature` covers the canonical serialization of all
 * other fields (see security/crypto.ts `canonicalizeForSignature`).
 */
export interface Envelope<T extends MessageType = MessageType> {
  version: number;
  messageId: string;
  timestamp: number;
  sender: string;
  /** Target device id, or "*" for broadcast/handshake pre-identification. */
  receiver: string;
  type: T;
  payload: MessagePayloads[T];
  /** Base64url Ed25519 signature over the canonical form; empty pre-handshake. */
  signature: string;
}

/** Convenience alias for any envelope in a union-friendly form. */
export type AnyEnvelope = {
  [T in MessageType]: Envelope<T>;
}[MessageType];

export const BROADCAST_RECEIVER = "*" as const;
