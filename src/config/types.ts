/**
 * Configuration contract.
 *
 * Purpose: single typed source of truth for every tunable. No module reads
 * environment variables or hardcodes intervals directly — they receive a
 * resolved `AirShareConfig`. This keeps behaviour deterministic and testable.
 */

import type { Platform } from "../types/device.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface NetworkConfig {
  /** TCP port for this node's WebSocket server. 0 = OS-assigned ephemeral. */
  port: number;
  /** Interface to bind. "0.0.0.0" listens on all interfaces. */
  host: string;
  /** How long to wait for a socket/handshake before failing, in ms. */
  connectTimeoutMs: number;
  /** Max payload size accepted on a single frame, in bytes. */
  maxFrameBytes: number;
}

export interface DiscoveryConfig {
  /** mDNS service type, without leading underscore convention noise. */
  serviceType: string;
  /** Re-announce interval, in ms. */
  announceIntervalMs: number;
  /** Whether to auto-dial trusted devices as soon as they are discovered. */
  autoConnectTrusted: boolean;
}

export interface HeartbeatConfig {
  /** Interval between PINGs on an active connection, in ms. */
  intervalMs: number;
  /** Max time to wait for a PONG before counting a miss, in ms. */
  timeoutMs: number;
  /** Consecutive misses before the peer is declared unreachable. */
  maxMissed: number;
}

export interface ReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Multiplier applied each attempt (exponential backoff). */
  factor: number;
  /** 0..1 random jitter fraction applied to each delay. */
  jitter: number;
  /** Max attempts before giving up; 0 = unlimited while device is discovered. */
  maxAttempts: number;
}

export interface SecurityConfig {
  /** Require explicit user approval on first contact with an unknown device. */
  requirePairingApproval: boolean;
  /** Reject messages whose timestamp drifts beyond this window, in ms. */
  clockSkewToleranceMs: number;
  /** Length of the human-readable pairing verification code. */
  verificationCodeLength: number;
}

export interface AirShareConfig {
  deviceName: string;
  platform: Platform;
  logLevel: LogLevel;
  /** Directory for persisted identity, keys and trust store. */
  dataDir: string;
  network: NetworkConfig;
  discovery: DiscoveryConfig;
  heartbeat: HeartbeatConfig;
  reconnect: ReconnectConfig;
  security: SecurityConfig;
}

/** Deep-partial overrides accepted by the config loader. */
export type PartialConfig = {
  [K in keyof AirShareConfig]?: AirShareConfig[K] extends object
    ? Partial<AirShareConfig[K]>
    : AirShareConfig[K];
};
