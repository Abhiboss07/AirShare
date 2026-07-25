import { describe, it, expect } from "vitest";
import {
  MessageCodec,
  createEnvelope,
  validateEnvelope,
  ProtocolError,
  FrameType,
} from "../../src/network/protocol.js";
import { MessageType, PROTOCOL_VERSION, ErrorCode } from "../../src/types/messages.js";
import { generateEphemeralKeyPair, deriveSession } from "../../src/security/session.js";

const codec = new MessageCodec(1024 * 1024);

describe("validateEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const env = createEnvelope("a", "b", MessageType.Ping, { seq: 1 });
    expect(validateEnvelope(env).type).toBe(MessageType.Ping);
  });

  it("rejects a non-object", () => {
    expect(() => validateEnvelope(null)).toThrow(ProtocolError);
  });

  it("rejects an unsupported version", () => {
    const env = { ...createEnvelope("a", "b", MessageType.Ping, { seq: 1 }), version: 999 };
    try {
      validateEnvelope(env);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ProtocolError).code).toBe(ErrorCode.UnsupportedVersion);
    }
  });

  it("rejects an unknown message type", () => {
    const env = { ...createEnvelope("a", "b", MessageType.Ping, { seq: 1 }), type: "NOPE" };
    expect(() => validateEnvelope(env)).toThrow(ProtocolError);
  });
});

describe("MessageCodec", () => {
  it("encodes and decodes a plaintext frame", () => {
    const env = createEnvelope("a", "b", MessageType.Hello, {
      name: "n",
      platform: "linux",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { messaging: true },
      publicKey: "pk",
      ephemeralPublicKey: "epk",
      nonce: "nonce",
    });
    const frame = codec.encodePlaintext(env);
    expect(frame[0]).toBe(FrameType.Plaintext);
    const decoded = codec.decode(frame, undefined);
    expect(decoded.frameType).toBe(FrameType.Plaintext);
    expect(decoded.envelope.type).toBe(MessageType.Hello);
  });

  it("encodes and decodes an encrypted frame with a session", () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const sessionA = deriveSession({
      role: "initiator",
      ourEphemeralPrivate: a.privateKey,
      peerEphemeralPublicRaw: b.publicKeyRaw,
      initiatorEphemeralPublicRaw: a.publicKeyRaw,
      responderEphemeralPublicRaw: b.publicKeyRaw,
    });
    const sessionB = deriveSession({
      role: "responder",
      ourEphemeralPrivate: b.privateKey,
      peerEphemeralPublicRaw: a.publicKeyRaw,
      initiatorEphemeralPublicRaw: a.publicKeyRaw,
      responderEphemeralPublicRaw: b.publicKeyRaw,
    });
    const env = createEnvelope("a", "b", MessageType.Message, { channel: "c", data: { x: 1 } });
    const frame = codec.encodeEncrypted(sessionA, env);
    expect(frame[0]).toBe(FrameType.Encrypted);
    const decoded = codec.decode(frame, sessionB);
    expect(decoded.envelope.type).toBe(MessageType.Message);
  });

  it("refuses an encrypted frame without a session", () => {
    const a = generateEphemeralKeyPair();
    const b = generateEphemeralKeyPair();
    const sessionA = deriveSession({
      role: "initiator",
      ourEphemeralPrivate: a.privateKey,
      peerEphemeralPublicRaw: b.publicKeyRaw,
      initiatorEphemeralPublicRaw: a.publicKeyRaw,
      responderEphemeralPublicRaw: b.publicKeyRaw,
    });
    const frame = codec.encodeEncrypted(sessionA, createEnvelope("a", "b", MessageType.Ping, { seq: 1 }));
    expect(() => codec.decode(frame, undefined)).toThrow(ProtocolError);
  });

  it("rejects an oversized frame", () => {
    const small = new MessageCodec(4);
    const frame = codec.encodePlaintext(createEnvelope("a", "b", MessageType.Ping, { seq: 1 }));
    expect(() => small.decode(frame, undefined)).toThrow(/maximum size/);
  });
});
