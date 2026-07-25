/**
 * Authenticated key agreement and payload encryption.
 *
 * Purpose: after both peers exchange signed HELLO messages, they derive a
 * shared AES-256-GCM key via X25519 ECDH. The ephemeral keys give forward
 * secrecy; binding them to signed HELLOs authenticates the exchange (defeats
 * MITM). Application frames are then encrypted with direction-separated keys.
 *
 * Public API: `generateEphemeralKeyPair`, `deriveSession`, and the
 * `SecureSession` class (`encrypt` / `decrypt`).
 *
 * Design note (why not TLS): self-signed TLS on a LAN encrypts the pipe but
 * cannot by itself prove *which device* is on the other end without pinning.
 * We already require identity-bound crypto for pairing, so an authenticated
 * ECDH signed by each party's long-term Ed25519 key gives encryption AND mutual
 * authentication in one mechanism that also works over future binary/WebRTC
 * transports. TLS can still wrap the socket later as defence in depth.
 */

import {
  generateKeyPairSync,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from "node:crypto";
import { toBase64Url } from "../utils/ids.js";

const AES_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12; // 96-bit nonce, standard for GCM
const GCM_TAG_BYTES = 16;
const HKDF_INFO_TX = "air-share/session/v1/initiator->responder";
const HKDF_INFO_RX = "air-share/session/v1/responder->initiator";

export type SessionRole = "initiator" | "responder";

export interface EphemeralKeyPair {
  privateKey: KeyObject;
  /** Base64url raw 32-byte X25519 public key, sent in HELLO. */
  publicKeyRaw: string;
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("x25519 public key JWK missing 'x'");
  return { privateKey, publicKeyRaw: jwk.x };
}

function importX25519PublicKey(rawB64: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: rawB64 },
    format: "jwk",
  });
}

export interface DeriveSessionParams {
  role: SessionRole;
  ourEphemeralPrivate: KeyObject;
  peerEphemeralPublicRaw: string;
  /** Both ephemeral public keys, used as HKDF salt so both sides agree. */
  initiatorEphemeralPublicRaw: string;
  responderEphemeralPublicRaw: string;
}

/**
 * Derive a `SecureSession` from the completed handshake. Both peers compute the
 * identical shared secret; direction-separated HKDF outputs avoid nonce reuse
 * hazards across the two flows.
 */
export function deriveSession(params: DeriveSessionParams): SecureSession {
  const shared = diffieHellman({
    privateKey: params.ourEphemeralPrivate,
    publicKey: importX25519PublicKey(params.peerEphemeralPublicRaw),
  });

  // Salt binds the derived keys to this specific pair of ephemeral keys.
  const salt = Buffer.concat([
    Buffer.from(params.initiatorEphemeralPublicRaw, "base64url"),
    Buffer.from(params.responderEphemeralPublicRaw, "base64url"),
  ]);

  const initiatorToResponder = Buffer.from(
    hkdfSync("sha256", shared, salt, HKDF_INFO_TX, AES_KEY_BYTES),
  );
  const responderToInitiator = Buffer.from(
    hkdfSync("sha256", shared, salt, HKDF_INFO_RX, AES_KEY_BYTES),
  );

  const [txKey, rxKey] =
    params.role === "initiator"
      ? [initiatorToResponder, responderToInitiator]
      : [responderToInitiator, initiatorToResponder];

  return new SecureSession(txKey, rxKey);
}

/**
 * An established encrypted session. Frame layout: [12B IV][ciphertext][16B tag].
 * Uses separate transmit/receive keys so the two directions never share a
 * (key, nonce) space.
 */
export class SecureSession {
  constructor(
    private readonly txKey: Buffer,
    private readonly rxKey: Buffer,
  ) {}

  encrypt(plaintext: Buffer): Buffer {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.txKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, tag]);
  }

  decrypt(frame: Buffer): Buffer {
    if (frame.length < GCM_IV_BYTES + GCM_TAG_BYTES) {
      throw new Error("ciphertext frame too short");
    }
    const iv = frame.subarray(0, GCM_IV_BYTES);
    const tag = frame.subarray(frame.length - GCM_TAG_BYTES);
    const ciphertext = frame.subarray(GCM_IV_BYTES, frame.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.rxKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Expose key fingerprints for debugging/tests without leaking key bytes. */
  debugFingerprint(): string {
    return toBase64Url(this.txKey.subarray(0, 4)) + ":" + toBase64Url(this.rxKey.subarray(0, 4));
  }
}
