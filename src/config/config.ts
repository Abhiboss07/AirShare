/**
 * Configuration loader & validator.
 *
 * Purpose: merge caller overrides onto defaults, apply environment overrides,
 * and validate the result so misconfiguration fails fast at startup rather than
 * surfacing as obscure runtime bugs.
 *
 * Public API: `loadConfig(overrides?)`.
 */

import { DEFAULT_CONFIG } from "./defaults.js";
import type { AirShareConfig, PartialConfig } from "./types.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function mergeSection<T extends object>(base: T, override: Partial<T> | undefined): T {
  return override ? { ...base, ...override } : base;
}

function applyEnvOverrides(config: AirShareConfig): AirShareConfig {
  const next = structuredCloneConfig(config);
  const env = process.env;
  if (env["AIRSHARE_DEVICE_NAME"]) next.deviceName = env["AIRSHARE_DEVICE_NAME"];
  if (env["AIRSHARE_PORT"]) next.network.port = Number(env["AIRSHARE_PORT"]);
  if (env["AIRSHARE_DATA_DIR"]) next.dataDir = env["AIRSHARE_DATA_DIR"];
  if (env["AIRSHARE_LOG_LEVEL"]) {
    next.logLevel = env["AIRSHARE_LOG_LEVEL"] as AirShareConfig["logLevel"];
  }
  return next;
}

function structuredCloneConfig(config: AirShareConfig): AirShareConfig {
  // Shallow-clone each nested section so overrides never mutate DEFAULT_CONFIG.
  return {
    ...config,
    network: { ...config.network },
    discovery: { ...config.discovery },
    heartbeat: { ...config.heartbeat },
    reconnect: { ...config.reconnect },
    security: { ...config.security },
  };
}

function validate(config: AirShareConfig): void {
  const errors: string[] = [];
  const { network, heartbeat, reconnect, security, discovery } = config;

  if (!config.deviceName.trim()) errors.push("deviceName must not be empty");
  if (network.port < 0 || network.port > 65_535) {
    errors.push("network.port must be within 0..65535");
  }
  if (network.connectTimeoutMs <= 0) errors.push("network.connectTimeoutMs must be > 0");
  if (network.maxFrameBytes <= 0) errors.push("network.maxFrameBytes must be > 0");
  if (heartbeat.intervalMs <= 0) errors.push("heartbeat.intervalMs must be > 0");
  if (heartbeat.timeoutMs <= 0) errors.push("heartbeat.timeoutMs must be > 0");
  if (heartbeat.maxMissed < 1) errors.push("heartbeat.maxMissed must be >= 1");
  if (reconnect.baseDelayMs <= 0) errors.push("reconnect.baseDelayMs must be > 0");
  if (reconnect.maxDelayMs < reconnect.baseDelayMs) {
    errors.push("reconnect.maxDelayMs must be >= reconnect.baseDelayMs");
  }
  if (reconnect.factor < 1) errors.push("reconnect.factor must be >= 1");
  if (reconnect.jitter < 0 || reconnect.jitter > 1) {
    errors.push("reconnect.jitter must be within 0..1");
  }
  if (security.verificationCodeLength < 4) {
    errors.push("security.verificationCodeLength must be >= 4");
  }
  if (security.clockSkewToleranceMs <= 0) {
    errors.push("security.clockSkewToleranceMs must be > 0");
  }
  if (!discovery.serviceType.trim()) errors.push("discovery.serviceType must not be empty");

  if (errors.length > 0) {
    throw new ConfigError(`Invalid configuration:\n- ${errors.join("\n- ")}`);
  }
}

/**
 * Resolve the effective configuration: defaults <- overrides <- env, validated.
 */
export function loadConfig(overrides: PartialConfig = {}): AirShareConfig {
  const merged: AirShareConfig = {
    ...DEFAULT_CONFIG,
    ...stripSections(overrides),
    network: mergeSection(DEFAULT_CONFIG.network, overrides.network),
    discovery: mergeSection(DEFAULT_CONFIG.discovery, overrides.discovery),
    heartbeat: mergeSection(DEFAULT_CONFIG.heartbeat, overrides.heartbeat),
    reconnect: mergeSection(DEFAULT_CONFIG.reconnect, overrides.reconnect),
    security: mergeSection(DEFAULT_CONFIG.security, overrides.security),
  };
  const withEnv = applyEnvOverrides(merged);
  validate(withEnv);
  return withEnv;
}

/** Drop nested-object keys so they don't overwrite the merged sections. */
function stripSections(overrides: PartialConfig): Partial<AirShareConfig> {
  const { network, discovery, heartbeat, reconnect, security, ...scalars } = overrides;
  void network;
  void discovery;
  void heartbeat;
  void reconnect;
  void security;
  return scalars as Partial<AirShareConfig>;
}
