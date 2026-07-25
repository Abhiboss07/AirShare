import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionManager } from "../../src/services/connectionManager.js";
import { EventBus } from "../../src/events/eventBus.js";
import { createLogger } from "../../src/utils/logger.js";
import type { WebSocketTransport } from "../../src/network/transport.js";
import type { DeviceRegistry } from "../../src/services/deviceRegistry.js";
import type { RemoteDevice } from "../../src/types/device.js";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";

const logger = createLogger("test", "silent");

function trustedRecord(id: string): RemoteDevice {
  return {
    identity: {
      id,
      name: id,
      publicKey: "pk",
      platform: "linux",
      protocolVersion: 1,
      capabilities: { messaging: true },
    },
    address: { host: "10.0.0.5", port: 4444 },
    status: "unreachable",
    trusted: true,
    lastSeen: Date.now(),
  };
}

describe("ConnectionManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(record: RemoteDevice | undefined) {
    const bus = new EventBus(logger);
    const connect = vi.fn();
    const transport = {
      isConnected: () => false,
      connect,
    } as unknown as WebSocketTransport;
    const registry = { get: () => record } as unknown as DeviceRegistry;
    const cm = new ConnectionManager(
      bus,
      transport,
      registry,
      { ...DEFAULT_CONFIG.reconnect, baseDelayMs: 1000, jitter: 0 },
      DEFAULT_CONFIG.discovery,
      logger,
    );
    cm.attach();
    return { bus, connect, cm };
  }

  it("auto-connects a trusted device on discovery", () => {
    const { bus, connect } = setup(trustedRecord("dev1"));
    bus.emit("device:found", {
      identity: trustedRecord("dev1").identity,
      address: { host: "10.0.0.5", port: 4444 },
    });
    expect(connect).toHaveBeenCalledWith({ host: "10.0.0.5", port: 4444 }, "dev1");
  });

  it("does not auto-connect an untrusted device", () => {
    const untrusted = { ...trustedRecord("dev2"), trusted: false };
    const { bus, connect } = setup(untrusted);
    bus.emit("device:found", { identity: untrusted.identity, address: untrusted.address });
    expect(connect).not.toHaveBeenCalled();
  });

  it("schedules a backoff reconnect after a disconnect", () => {
    const { bus, connect } = setup(trustedRecord("dev1"));
    bus.emit("device:disconnected", { deviceId: "dev1", reason: "socket closed" });
    expect(connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // first backoff = baseDelayMs
    expect(connect).toHaveBeenCalledWith({ host: "10.0.0.5", port: 4444 }, "dev1");
  });

  it("stops chasing a device that became lost", () => {
    const lost = { ...trustedRecord("dev1"), status: "lost" as const };
    const { bus, connect } = setup(lost);
    bus.emit("device:unreachable", { deviceId: "dev1" });
    vi.advanceTimersByTime(5000);
    expect(connect).not.toHaveBeenCalled();
  });
});
