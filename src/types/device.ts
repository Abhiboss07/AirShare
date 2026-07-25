/**
 * Device domain types.
 *
 * Purpose: describe the identity and runtime status of Air Share devices —
 * both this local node and remote peers discovered on the network.
 *
 * Future integration: gesture/clipboard/file-transfer phases attach their own
 * capability flags to `DeviceCapabilities` without changing transport code.
 */

/**
 * Feature capabilities a device advertises. Phase 1 only guarantees `messaging`.
 * Later phases flip these on as they land, so peers can negotiate features.
 */
export interface DeviceCapabilities {
  messaging: boolean;
  clipboard?: boolean;
  fileTransfer?: boolean;
  gestures?: boolean;
  streaming?: boolean;
}

export type Platform = "linux" | "windows" | "macos" | "android" | "ios" | "unknown";

/**
 * Immutable identity of a device. `id` is derived deterministically from the
 * long-term Ed25519 public key (see security/identity.ts), so it cannot be
 * spoofed without the corresponding private key.
 */
export interface DeviceIdentity {
  /** Stable device id = fingerprint of the public signing key. */
  readonly id: string;
  /** Human-friendly display name (configurable, not trusted for identity). */
  readonly name: string;
  /** Base64url-encoded Ed25519 public signing key. */
  readonly publicKey: string;
  readonly platform: Platform;
  readonly protocolVersion: number;
  readonly capabilities: DeviceCapabilities;
}

/** Lifecycle state of a peer as tracked by the DeviceRegistry. */
export type DeviceStatus =
  | "discovered" // seen via mDNS, not yet connected
  | "connecting"
  | "pairing" // handshake done, awaiting trust approval
  | "connected" // authenticated, session active
  | "unreachable" // was connected, heartbeat lost, retrying
  | "lost"; // discovery record disappeared

/** Network coordinates for dialing a peer. */
export interface DeviceAddress {
  host: string;
  port: number;
}

/**
 * The full runtime record of a peer: its advertised identity plus locally
 * observed state. `trusted` reflects the pairing store, not the advertisement.
 */
export interface RemoteDevice {
  identity: DeviceIdentity;
  address: DeviceAddress;
  status: DeviceStatus;
  trusted: boolean;
  lastSeen: number;
  /** Round-trip time of the last successful heartbeat, in ms, if known. */
  rttMs?: number;
}

/** A persisted trust record for a paired device. */
export interface TrustedDeviceRecord {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: number;
  lastConnectedAt?: number;
}
