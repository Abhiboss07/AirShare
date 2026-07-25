/**
 * PairingService — trust policy for the handshake.
 *
 * Purpose: implement `PairingAuthorizer`. When a PeerConnection finishes key
 * exchange it asks this service whether to trust the peer. Already-trusted
 * devices are approved instantly (giving "automatic future connections");
 * unknown devices raise a `pair:request` event carrying the verification code
 * and accept/reject callbacks, so a UI (or the CLI) can approve first contact.
 *
 * Responsibilities: enforce identity binding, consult/persist trust, mediate the
 * user-approval round-trip, and emit pairing outcome events.
 *
 * Dependencies: TrustManager, EventBus, Logger, SecurityConfig.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { TrustManager } from "../security/trust.js";
import type { SecurityConfig } from "../config/types.js";
import type { DeviceIdentity, RemoteDevice } from "../types/device.js";
import type { PairingAuthorizer } from "../network/transport.js";

export class PairingService implements PairingAuthorizer {
  constructor(
    private readonly trust: TrustManager,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
    private readonly security: SecurityConfig,
  ) {}

  async authorize(remote: DeviceIdentity, sas: string): Promise<boolean> {
    // Defense in depth: the connection already checked binding, but never trust
    // an identity whose id is not the fingerprint of its key.
    if (!this.trust.verifyIdentityBinding(remote)) {
      this.logger.warn("pairing rejected: identity binding failed", { id: remote.id });
      return false;
    }

    // Known device presenting a changed key => refuse (possible impersonation).
    if (await this.trust.isTrusted(remote.id)) {
      if (await this.trust.matchesStoredKey(remote)) {
        this.logger.debug("auto-approving trusted device", { id: remote.id });
        await this.trust.markConnected(remote.id);
        return true;
      }
      this.logger.warn("known device presented a different key, rejecting", { id: remote.id });
      return false;
    }

    if (!this.security.requirePairingApproval) {
      await this.trust.trust(remote);
      this.emitAccepted(remote);
      return true;
    }

    return this.requestUserApproval(remote, sas);
  }

  private requestUserApproval(remote: DeviceIdentity, sas: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const accept = (): void => {
        if (settled) return;
        settled = true;
        this.trust
          .trust(remote)
          .then(() => {
            this.emitAccepted(remote);
            resolve(true);
          })
          .catch((error: unknown) => {
            this.logger.error("failed to persist trust", {
              error: error instanceof Error ? error : new Error(String(error)),
            });
            resolve(false);
          });
      };
      const reject = (reason = "rejected by user"): void => {
        if (settled) return;
        settled = true;
        this.eventBus.emit("pair:rejected", { deviceId: remote.id, reason });
        resolve(false);
      };

      const device: RemoteDevice = {
        identity: remote,
        address: { host: "unknown", port: 0 },
        status: "pairing",
        trusted: false,
        lastSeen: Date.now(),
      };
      this.logger.info("pairing approval required", { id: remote.id, sas });
      this.eventBus.emit("pair:request", { device, verificationCode: sas, accept, reject });
    });
  }

  private emitAccepted(remote: DeviceIdentity): void {
    const device: RemoteDevice = {
      identity: remote,
      address: { host: "unknown", port: 0 },
      status: "connected",
      trusted: true,
      lastSeen: Date.now(),
    };
    this.eventBus.emit("pair:accepted", { device });
  }
}
