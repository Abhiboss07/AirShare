/**
 * SessionKeyedCipherProvider — real end-to-end entity encryption over the mesh.
 *
 * Purpose: derive a per-peer `AesGcmCipher` from the shared, purpose-separated
 * entity key of the live secure session (see `SecureSession.entityKey`). The
 * object itself is encrypted with a key only the two endpoints hold, so it stays
 * protected even if a future transport relays the ciphertext through an
 * untrusted hop — independent of the transport-level session encryption.
 *
 * This is the only place the mesh seam turns session key material into an entity
 * cipher; it lives here (not in `transfer/`) because it depends on the messenger.
 */

import { AesGcmCipher, NoopCipher, type EntityCipher } from "../transfer/entityCipher.js";
import type { CipherProvider } from "../transfer/cipherProvider.js";
import type { MeshMessenger } from "./messenger.js";
import type { Logger } from "../utils/logger.js";

interface CachedCipher {
  keyHex: string;
  cipher: AesGcmCipher;
}

export class SessionKeyedCipherProvider implements CipherProvider {
  private readonly cache = new Map<string, CachedCipher>();
  private readonly fallback = new NoopCipher();

  constructor(
    private readonly messenger: MeshMessenger,
    private readonly logger?: Logger,
  ) {}

  cipherFor(peerId: string): EntityCipher {
    const key = this.messenger.entityKeyFor(peerId);
    if (!key) {
      // No session yet (e.g. loopback/test before connect): fall back to Noop.
      this.logger?.debug("no session key for peer, using noop cipher", { peer: peerId });
      return this.fallback;
    }
    const keyHex = key.toString("hex");
    const cached = this.cache.get(peerId);
    if (cached && cached.keyHex === keyHex) return cached.cipher;

    // First contact or the key rotated (reconnect → new ephemeral session).
    const cipher = new AesGcmCipher(key);
    this.cache.set(peerId, { keyHex, cipher });
    this.logger?.debug("keyed entity cipher from session", { peer: peerId });
    return cipher;
  }

  /** Drop a peer's cached cipher (e.g. on disconnect). */
  forget(peerId: string): void {
    this.cache.delete(peerId);
  }
}
