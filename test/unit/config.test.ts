import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../../src/config/config.js";

describe("loadConfig", () => {
  it("returns defaults with no overrides", () => {
    const cfg = loadConfig();
    expect(cfg.network.port).toBe(0);
    expect(cfg.heartbeat.maxMissed).toBeGreaterThanOrEqual(1);
  });

  it("merges nested overrides without dropping sibling defaults", () => {
    const cfg = loadConfig({ heartbeat: { intervalMs: 1234 } });
    expect(cfg.heartbeat.intervalMs).toBe(1234);
    expect(cfg.heartbeat.timeoutMs).toBe(3000); // default preserved
  });

  it("applies scalar overrides", () => {
    const cfg = loadConfig({ deviceName: "MyPhone" });
    expect(cfg.deviceName).toBe("MyPhone");
  });

  it("rejects invalid configuration", () => {
    expect(() => loadConfig({ network: { port: 70000 } })).toThrow(ConfigError);
    expect(() => loadConfig({ reconnect: { baseDelayMs: 10, maxDelayMs: 5 } })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ security: { verificationCodeLength: 2 } })).toThrow(ConfigError);
  });

  it("does not mutate defaults across calls", () => {
    loadConfig({ network: { port: 4000 } });
    expect(loadConfig().network.port).toBe(0);
  });
});
