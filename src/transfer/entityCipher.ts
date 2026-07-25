/**
 * EntityCipher — payload encryption abstraction.
 *
 * Purpose: entities are encrypted before they leave a device (and can be
 * encrypted at rest in the cache). The runtime depends on this interface, not a
 * concrete algorithm, so Phase 5 can plug in a cipher keyed by the live peer
 * session (SecureSession) while Phase 3 uses a local AES-256-GCM key. A Noop
 * cipher exists for tests and the in-memory loopback.
 *
 * This is a crypto primitive, not networking — it depends only on node:crypto.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { EntityEncryption } from "../types/transfer.js";

export interface EntityCipher {
  readonly algorithm: string;
  encrypt(plaintext: Buffer): Promise<{ ciphertext: Buffer; meta: EntityEncryption }>;
  decrypt(ciphertext: Buffer, meta: EntityEncryption): Promise<Buffer>;
}

/** No encryption — passthrough. Only for tests / trusted loopback. */
export class NoopCipher implements EntityCipher {
  readonly algorithm = "none";
  async encrypt(plaintext: Buffer): Promise<{ ciphertext: Buffer; meta: EntityEncryption }> {
    return { ciphertext: plaintext, meta: { algorithm: this.algorithm } };
  }
  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    return ciphertext;
  }
}

/**
 * AES-256-GCM with a symmetric key. In Phase 3 the same key instance is shared
 * by both endpoints (simulating an agreed session key); in Phase 5 the key comes
 * from the authenticated ECDH session, so this class is reused unchanged.
 */
export class AesGcmCipher implements EntityCipher {
  readonly algorithm = "aes-256-gcm";
  private readonly key: Buffer;

  constructor(key?: Buffer) {
    if (key && key.length !== 32) throw new Error("AesGcmCipher requires a 32-byte key");
    this.key = key ?? randomBytes(32);
  }

  async encrypt(plaintext: Buffer): Promise<{ ciphertext: Buffer; meta: EntityEncryption }> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext,
      meta: {
        algorithm: this.algorithm,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
      },
    };
  }

  async decrypt(ciphertext: Buffer, meta: EntityEncryption): Promise<Buffer> {
    if (!meta.iv || !meta.tag) throw new Error("missing iv/tag for AES-GCM decryption");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(meta.iv, "base64"));
    decipher.setAuthTag(Buffer.from(meta.tag, "base64"));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
