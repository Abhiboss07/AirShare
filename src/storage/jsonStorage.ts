/**
 * JSON-file storage provider.
 *
 * Purpose: the default `StorageProvider` implementation. Persists identity,
 * trusted devices and settings under the configured data directory as atomic
 * JSON documents. Secrets (identity) use 0600 permissions.
 *
 * Dependencies: JsonDocument, node:fs. No native modules — portable across all
 * target platforms. Swap this class for a SqliteStorageProvider later without
 * touching callers.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { JsonDocument } from "./jsonDocument.js";
import type {
  IdentityRepository,
  SettingsRepository,
  StorageProvider,
  TrustRepository,
} from "./types.js";
import type { ExportedIdentity } from "../security/identity.js";
import type { TrustedDeviceRecord } from "../types/device.js";

interface TrustFile {
  devices: Record<string, TrustedDeviceRecord>;
}
interface SettingsFile {
  values: Record<string, unknown>;
}

class JsonIdentityRepository implements IdentityRepository {
  constructor(private readonly doc: JsonDocument<ExportedIdentity | null>) {}

  async load(): Promise<ExportedIdentity | undefined> {
    return (await this.doc.read()) ?? undefined;
  }
  async save(identity: ExportedIdentity): Promise<void> {
    await this.doc.write(identity);
  }
}

class JsonTrustRepository implements TrustRepository {
  constructor(private readonly doc: JsonDocument<TrustFile>) {}

  async list(): Promise<TrustedDeviceRecord[]> {
    return Object.values((await this.doc.read()).devices);
  }
  async get(deviceId: string): Promise<TrustedDeviceRecord | undefined> {
    return (await this.doc.read()).devices[deviceId];
  }
  async isTrusted(deviceId: string): Promise<boolean> {
    return Boolean((await this.doc.read()).devices[deviceId]);
  }
  async upsert(record: TrustedDeviceRecord): Promise<void> {
    await this.doc.update((file) => ({
      devices: { ...file.devices, [record.id]: record },
    }));
  }
  async remove(deviceId: string): Promise<void> {
    await this.doc.update((file) => {
      const devices = { ...file.devices };
      delete devices[deviceId];
      return { devices };
    });
  }
}

class JsonSettingsRepository implements SettingsRepository {
  constructor(private readonly doc: JsonDocument<SettingsFile>) {}

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.doc.read()).values[key] as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.doc.update((file) => ({
      values: { ...file.values, [key]: value },
    }));
  }
  async delete(key: string): Promise<void> {
    await this.doc.update((file) => {
      const values = { ...file.values };
      delete values[key];
      return { values };
    });
  }
}

export class JsonStorageProvider implements StorageProvider {
  readonly identity: IdentityRepository;
  readonly trust: TrustRepository;
  readonly settings: SettingsRepository;

  constructor(private readonly dataDir: string) {
    this.identity = new JsonIdentityRepository(
      new JsonDocument<ExportedIdentity | null>(
        path.join(dataDir, "identity.json"),
        null,
        0o600,
      ),
    );
    this.trust = new JsonTrustRepository(
      new JsonDocument<TrustFile>(path.join(dataDir, "trusted.json"), { devices: {} }, 0o600),
    );
    this.settings = new JsonSettingsRepository(
      new JsonDocument<SettingsFile>(path.join(dataDir, "settings.json"), { values: {} }, 0o644),
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
  }
}
