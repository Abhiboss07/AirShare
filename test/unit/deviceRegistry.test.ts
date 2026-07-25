import { describe, it, expect } from "vitest";
import { DeviceRegistry } from "../../src/services/deviceRegistry.js";
import { EventBus } from "../../src/events/eventBus.js";
import { TrustManager } from "../../src/security/trust.js";
import { createLogger } from "../../src/utils/logger.js";
import type { TrustRepository } from "../../src/storage/types.js";
import type { DeviceIdentity, RemoteDevice } from "../../src/types/device.js";

const logger = createLogger("test", "silent");
const flush = () => new Promise((r) => setImmediate(r));

const emptyTrust: TrustRepository = {
  list: async () => [],
  get: async () => undefined,
  isTrusted: async () => false,
  upsert: async () => {},
  remove: async () => {},
};

const identity: DeviceIdentity = {
  id: "dev1",
  name: "Dev One",
  publicKey: "pk",
  platform: "linux",
  protocolVersion: 1,
  capabilities: { messaging: true },
};

function makeRegistry() {
  const bus = new EventBus(logger);
  const registry = new DeviceRegistry(bus, new TrustManager(emptyTrust), logger);
  registry.attach();
  return { bus, registry };
}

describe("DeviceRegistry", () => {
  it("records a discovered device", async () => {
    const { bus, registry } = makeRegistry();
    bus.emit("device:found", { identity, address: { host: "h", port: 1 } });
    await flush();
    expect(registry.get("dev1")?.status).toBe("discovered");
  });

  it("transitions through connect / heartbeat / disconnect", async () => {
    const { bus, registry } = makeRegistry();
    bus.emit("device:found", { identity, address: { host: "h", port: 1 } });
    await flush();

    const connected: RemoteDevice = {
      identity,
      address: { host: "h", port: 1 },
      status: "connected",
      trusted: true,
      lastSeen: Date.now(),
    };
    bus.emit("device:connected", { device: connected });
    expect(registry.get("dev1")?.status).toBe("connected");

    bus.emit("heartbeat:ok", { deviceId: "dev1", rttMs: 12 });
    expect(registry.get("dev1")?.rttMs).toBe(12);

    bus.emit("device:disconnected", { deviceId: "dev1", reason: "bye" });
    expect(registry.get("dev1")?.status).toBe("unreachable");
  });

  it("keeps a connected device even if discovery blinks", async () => {
    const { bus, registry } = makeRegistry();
    const connected: RemoteDevice = {
      identity,
      address: { host: "h", port: 1 },
      status: "connected",
      trusted: true,
      lastSeen: Date.now(),
    };
    bus.emit("device:connected", { device: connected });
    bus.emit("device:lost", { deviceId: "dev1" });
    expect(registry.get("dev1")?.status).toBe("connected");
  });
});
