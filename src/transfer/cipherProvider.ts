/**
 * CipherProvider — selects the entity cipher for a given peer.
 *
 * Purpose: end-to-end entity encryption is *per peer* — each connected device
 * pair shares its own key. The runtime therefore can't hold a single cipher; it
 * asks a provider for the right cipher given the peer id (the target on send, the
 * sender on receive). Because the shared key is symmetric, the same peer id
 * yields the same cipher on both ends.
 *
 * `StaticCipherProvider` wraps one cipher for every peer — it preserves the
 * Phase-3 behaviour (one shared/NoOp cipher) and keeps existing tests unchanged.
 * `SessionKeyedCipherProvider` (in the mesh layer) keys a real AES-GCM cipher
 * from the live secure session.
 */

import type { EntityCipher } from "./entityCipher.js";
import { NoopCipher } from "./entityCipher.js";

export interface CipherProvider {
  /** The cipher to use for the entity exchanged with `peerId`. */
  cipherFor(peerId: string): EntityCipher | Promise<EntityCipher>;
}

/** Uses the same cipher for every peer (default: Noop). */
export class StaticCipherProvider implements CipherProvider {
  constructor(private readonly cipher: EntityCipher = new NoopCipher()) {}
  cipherFor(): EntityCipher {
    return this.cipher;
  }
}
