/**
 * CapabilityService — device feature negotiation.
 *
 * Purpose: when two devices connect, each announces what it supports (clipboard,
 * files, ocr, stream, camera, window-capture, …). Knowing a peer's capabilities
 * lets the runtime avoid doomed transfers (e.g. don't offer window-capture to a
 * phone) and pick compatible formats. Exchange happens over an encrypted channel
 * on the Phase-1 mesh, right after `device:connected`.
 *
 * Note: Phase-1 already advertises coarse boolean capabilities in the HELLO
 * handshake; this adds the richer, extensible `supports: string[]` document the
 * higher layers actually reason about.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import type { MeshMessenger } from "./messenger.js";
import type { CapabilityDoc } from "../types/transfer.js";

export const CHANNEL_CAPABILITIES = "airshare/capabilities";

export class CapabilityService {
  private readonly remote = new Map<string, CapabilityDoc>();
  private readonly announcedTo = new Set<string>();
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    private readonly messenger: MeshMessenger,
    private readonly eventBus: IEventBus,
    private readonly localDoc: CapabilityDoc,
    private readonly logger: Logger,
  ) {}

  attach(): void {
    this.unsubscribes.push(
      this.messenger.onConnected((deviceId) => this.announce(deviceId)),
      this.messenger.onMessage((from, channel, data) => {
        if (channel === CHANNEL_CAPABILITIES) this.onCapabilities(from, data as CapabilityDoc);
      }),
    );
  }

  detach(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  /** What we advertise about ourselves. */
  get local(): CapabilityDoc {
    return this.localDoc;
  }

  private announce(deviceId: string): void {
    if (this.messenger.sendTo(deviceId, CHANNEL_CAPABILITIES, this.localDoc)) {
      this.announcedTo.add(deviceId);
      this.logger.debug("announced capabilities", { to: deviceId });
    }
  }

  private onCapabilities(from: string, doc: CapabilityDoc): void {
    this.remote.set(from, doc);
    this.logger.info("capabilities negotiated", { device: from, supports: doc.supports });
    this.eventBus.emit("capabilities:negotiated", { deviceId: from, capabilities: doc.supports });
    // Ensure both sides learn each other's capabilities even if we connected first.
    if (!this.announcedTo.has(from)) this.announce(from);
  }

  /** Does `deviceId` support `capability`? Unknown devices return false. */
  supports(deviceId: string, capability: string): boolean {
    return this.remote.get(deviceId)?.supports.includes(capability) ?? false;
  }

  capabilitiesOf(deviceId: string): CapabilityDoc | undefined {
    return this.remote.get(deviceId);
  }
}
