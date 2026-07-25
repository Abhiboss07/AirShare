/**
 * Default configuration values.
 *
 * Every magic number in the system lives here with a rationale, so there are no
 * unexplained constants scattered through the codebase.
 */

import os from "node:os";
import path from "node:path";
import type { AirShareConfig } from "./types.js";
import type { Platform } from "../types/device.js";

function detectPlatform(): Platform {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "unknown";
  }
}

function defaultDataDir(): string {
  // XDG-friendly on Linux; falls back to ~/.air-share elsewhere.
  const xdg = process.env["XDG_DATA_HOME"];
  if (xdg) return path.join(xdg, "air-share");
  return path.join(os.homedir(), ".air-share");
}

export const DEFAULT_CONFIG: AirShareConfig = {
  deviceName: os.hostname() || "air-share-device",
  platform: detectPlatform(),
  logLevel: "info",
  dataDir: defaultDataDir(),
  network: {
    port: 0, // ephemeral by default so multiple nodes coexist on one host
    host: "0.0.0.0",
    connectTimeoutMs: 10_000,
    maxFrameBytes: 16 * 1024 * 1024, // 16 MiB — generous for Phase-1 control msgs
  },
  discovery: {
    serviceType: "airshare",
    announceIntervalMs: 30_000,
    autoConnectTrusted: true,
  },
  heartbeat: {
    intervalMs: 5_000,
    timeoutMs: 3_000,
    maxMissed: 3, // ~15s of silence before declaring unreachable
  },
  reconnect: {
    enabled: true,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    factor: 2,
    jitter: 0.2,
    maxAttempts: 0, // retry as long as the device is still discovered
  },
  security: {
    requirePairingApproval: true,
    clockSkewToleranceMs: 60_000,
    verificationCodeLength: 6,
  },
};
