/**
 * Trust management.
 *
 * Purpose: the authority on which remote devices are paired/trusted, and the
 * guard that an advertised identity actually owns the key its id claims. Wraps
 * the persistence `TrustRepository` with domain rules so pairing and transport
 * code depend on intent ("is this device trusted?") not storage details.
 *
 * Public API: `verifyIdentityBinding`, `isTrusted`, `trust`, `revoke`, `list`.
 */

import { deviceIdFor } from "./identity.js";
import type { TrustRepository } from "../storage/types.js";
import type { DeviceIdentity, TrustedDeviceRecord } from "../types/device.js";

export class TrustManager {
  constructor(private readonly repo: TrustRepository) {}

  /**
   * Reject identities whose declared id is not the fingerprint of their public
   * key. This is the anti-spoofing check: an attacker cannot claim another
   * device's id without also presenting that device's public key, and cannot
   * sign handshakes without the matching private key.
   */
  verifyIdentityBinding(identity: DeviceIdentity): boolean {
    return deviceIdFor(identity.publicKey) === identity.id;
  }

  isTrusted(deviceId: string): Promise<boolean> {
    return this.repo.isTrusted(deviceId);
  }

  async trust(identity: DeviceIdentity): Promise<TrustedDeviceRecord> {
    if (!this.verifyIdentityBinding(identity)) {
      throw new Error("refusing to trust device with mismatched id/public key");
    }
    const existing = await this.repo.get(identity.id);
    const record: TrustedDeviceRecord = {
      id: identity.id,
      name: identity.name,
      publicKey: identity.publicKey,
      pairedAt: existing?.pairedAt ?? Date.now(),
      lastConnectedAt: Date.now(),
    };
    await this.repo.upsert(record);
    return record;
  }

  async markConnected(deviceId: string): Promise<void> {
    const record = await this.repo.get(deviceId);
    if (record) {
      await this.repo.upsert({ ...record, lastConnectedAt: Date.now() });
    }
  }

  revoke(deviceId: string): Promise<void> {
    return this.repo.remove(deviceId);
  }

  list(): Promise<TrustedDeviceRecord[]> {
    return this.repo.list();
  }

  /**
   * Confirm a paired device still presents the exact public key we stored.
   * Guards against a discovery record reusing a trusted id with a new key.
   */
  async matchesStoredKey(identity: DeviceIdentity): Promise<boolean> {
    const record = await this.repo.get(identity.id);
    if (!record) return false;
    return record.publicKey === identity.publicKey;
  }
}
