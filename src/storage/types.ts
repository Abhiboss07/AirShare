/**
 * Storage abstractions.
 *
 * Purpose: define persistence contracts independent of the backing engine.
 * Phase 1 ships a JSON-file implementation; a SQLite implementation can be
 * dropped in later by satisfying these same interfaces (Dependency Inversion).
 *
 * Responsibilities: persist device identity/keys, the trusted-device set, and
 * arbitrary settings.
 */

import type { ExportedIdentity } from "../security/identity.js";
import type { TrustedDeviceRecord } from "../types/device.js";

export interface IdentityRepository {
  load(): Promise<ExportedIdentity | undefined>;
  save(identity: ExportedIdentity): Promise<void>;
}

export interface TrustRepository {
  list(): Promise<TrustedDeviceRecord[]>;
  get(deviceId: string): Promise<TrustedDeviceRecord | undefined>;
  isTrusted(deviceId: string): Promise<boolean>;
  upsert(record: TrustedDeviceRecord): Promise<void>;
  remove(deviceId: string): Promise<void>;
}

export interface SettingsRepository {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Aggregate handed to the rest of the app via dependency injection. */
export interface StorageProvider {
  readonly identity: IdentityRepository;
  readonly trust: TrustRepository;
  readonly settings: SettingsRepository;
  /** Ensure backing store is ready (create dirs, open files). */
  init(): Promise<void>;
}
