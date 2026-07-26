import { describe, it, expect } from "vitest";
import { createCipheriv } from "node:crypto";
import { Identity } from "../../src/security/identity.js";
import {
  signEnvelope,
  verifyEnvelopeSignature,
  stableStringify,
} from "../../src/security/crypto.js";
import { createEnvelope } from "../../src/network/protocol.js";
import { MessageType } from "../../src/types/messages.js";
import {
  generateEphemeralKeyPair,
  deriveSession,
} from "../../src/security/session.js";

describe("stableStringify", () => {
  it("is order-independent for object keys", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("distinguishes different values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
  it("omits undefined and preserves arrays", () => {
    expect(stableStringify({ a: undefined, b: [3, 1] })).toBe('{"b":[3,1]}');
  });
});

describe("envelope signing", () => {
  it("verifies a valid signature", () => {
    const id = Identity.generate();
    const env = createEnvelope(id.deviceId, "*", MessageType.Ping, { seq: 1 });
    const signed = signEnvelope(id, env);
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(verifyEnvelopeSignature(signed, id.publicKeyRaw)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const id = Identity.generate();
    const signed = signEnvelope(
      id,
      createEnvelope(id.deviceId, "*", MessageType.Ping, { seq: 1 }),
    );
    const tampered = { ...signed, payload: { seq: 999 } };
    expect(verifyEnvelopeSignature(tampered, id.publicKeyRaw)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = Identity.generate();
    const b = Identity.generate();
    const signed = signEnvelope(
      a,
      createEnvelope(a.deviceId, "*", MessageType.Ping, { seq: 1 }),
    );
    expect(verifyEnvelopeSignature(signed, b.publicKeyRaw)).toBe(false);
  });
});

describe("SecureSession (X25519 + AES-256-GCM)", () => {
  function pair() {
    const initiator = generateEphemeralKeyPair();
    const responder = generateEphemeralKeyPair();
    const sessionA = deriveSession({
      role: "initiator",
      ourEphemeralPrivate: initiator.privateKey,
      peerEphemeralPublicRaw: responder.publicKeyRaw,
      initiatorEphemeralPublicRaw: initiator.publicKeyRaw,
      responderEphemeralPublicRaw: responder.publicKeyRaw,
    });
    const sessionB = deriveSession({
      role: "responder",
      ourEphemeralPrivate: responder.privateKey,
      peerEphemeralPublicRaw: initiator.publicKeyRaw,
      initiatorEphemeralPublicRaw: initiator.publicKeyRaw,
      responderEphemeralPublicRaw: responder.publicKeyRaw,
    });
    return { sessionA, sessionB };
  }

  it("round-trips a message between the two derived sessions", () => {
    const { sessionA, sessionB } = pair();
    const plaintext = Buffer.from("hello air share");
    expect(sessionB.decrypt(sessionA.encrypt(plaintext)).toString()).toBe("hello air share");
    // and the other direction
    expect(sessionA.decrypt(sessionB.encrypt(plaintext)).toString()).toBe("hello air share");
  });

  it("fails to decrypt a tampered ciphertext", () => {
    const { sessionA, sessionB } = pair();
    const frame = sessionA.encrypt(Buffer.from("secret"));
    frame[frame.length - 1] ^= 0xff; // corrupt the auth tag
    expect(() => sessionB.decrypt(frame)).toThrow();
  });

  it("produces unrelated keys for an unrelated third party", () => {
    const { sessionA } = pair();
    const stranger = generateEphemeralKeyPair();
    const other = generateEphemeralKeyPair();
    const sessionC = deriveSession({
      role: "responder",
      ourEphemeralPrivate: stranger.privateKey,
      peerEphemeralPublicRaw: other.publicKeyRaw,
      initiatorEphemeralPublicRaw: other.publicKeyRaw,
      responderEphemeralPublicRaw: stranger.publicKeyRaw,
    });
    expect(() => sessionC.decrypt(sessionA.encrypt(Buffer.from("x")))).toThrow();
  });

  it("derives an identical, role-independent entity key on both peers", () => {
    const { sessionA, sessionB } = pair();
    // Symmetric: both sides agree on the same end-to-end entity key regardless
    // of who initiated. This is what lets a single AES key encrypt the object.
    expect(sessionA.entityKey().equals(sessionB.entityKey())).toBe(true);
    expect(sessionA.entityKey()).toHaveLength(32);
  });

  it("separates the entity key from the transport (tx/rx) keys", () => {
    const { sessionA, sessionB } = pair();
    // The entity key is purpose-separated from the transport keys: a frame
    // encrypted with the entity key must NOT decrypt as a transport frame.
    const iv = Buffer.alloc(12);
    const c = createCipheriv("aes-256-gcm", sessionA.entityKey(), iv);
    const ct = Buffer.concat([c.update(Buffer.from("obj")), c.final(), c.getAuthTag()]);
    expect(() => sessionB.decrypt(Buffer.concat([iv, ct]))).toThrow();
  });

  it("gives an unrelated third party a different entity key", () => {
    const { sessionA } = pair();
    const stranger = generateEphemeralKeyPair();
    const other = generateEphemeralKeyPair();
    const sessionC = deriveSession({
      role: "responder",
      ourEphemeralPrivate: stranger.privateKey,
      peerEphemeralPublicRaw: other.publicKeyRaw,
      initiatorEphemeralPublicRaw: other.publicKeyRaw,
      responderEphemeralPublicRaw: stranger.publicKeyRaw,
    });
    expect(sessionA.entityKey().equals(sessionC.entityKey())).toBe(false);
  });
});
