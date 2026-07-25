import { describe, it, expect } from "vitest";
import { Identity, deviceIdFor } from "../../src/security/identity.js";

describe("Identity", () => {
  it("derives a device id that is the fingerprint of the public key", () => {
    const id = Identity.generate();
    expect(id.deviceId).toBe(deviceIdFor(id.publicKeyRaw));
  });

  it("round-trips through export/import", () => {
    const id = Identity.generate();
    const restored = Identity.fromKeyMaterial(id.export());
    expect(restored.deviceId).toBe(id.deviceId);
    expect(restored.publicKeyRaw).toBe(id.publicKeyRaw);
    const data = Buffer.from("payload");
    expect(Identity.verify(data, restored.sign(data), id.publicKeyRaw)).toBe(true);
  });

  it("rejects key material with a mismatched device id", () => {
    const id = Identity.generate();
    const material = { ...id.export(), deviceId: "not-the-real-fingerprint" };
    expect(() => Identity.fromKeyMaterial(material)).toThrow();
  });

  it("generates distinct identities each time", () => {
    expect(Identity.generate().deviceId).not.toBe(Identity.generate().deviceId);
  });
});
