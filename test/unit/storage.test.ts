import { describe, it, expect, afterEach } from "vitest";
import { JsonStorageProvider } from "../../src/storage/jsonStorage.js";
import { Identity } from "../../src/security/identity.js";
import { tempDataDir, cleanup } from "../helpers.js";

let dir = "";
afterEach(async () => {
  if (dir) await cleanup(dir);
});

describe("JsonStorageProvider", () => {
  it("persists and reloads identity", async () => {
    dir = await tempDataDir();
    const storage = new JsonStorageProvider(dir);
    await storage.init();
    const id = Identity.generate();
    await storage.identity.save(id.export());

    const reopened = new JsonStorageProvider(dir);
    const loaded = await reopened.identity.load();
    expect(loaded?.deviceId).toBe(id.deviceId);
  });

  it("manages the trust set", async () => {
    dir = await tempDataDir();
    const storage = new JsonStorageProvider(dir);
    await storage.init();
    const rec = { id: "dev1", name: "Dev One", publicKey: "pk", pairedAt: Date.now() };

    expect(await storage.trust.isTrusted("dev1")).toBe(false);
    await storage.trust.upsert(rec);
    expect(await storage.trust.isTrusted("dev1")).toBe(true);
    expect((await storage.trust.list()).length).toBe(1);
    await storage.trust.remove("dev1");
    expect(await storage.trust.isTrusted("dev1")).toBe(false);
  });

  it("stores arbitrary settings", async () => {
    dir = await tempDataDir();
    const storage = new JsonStorageProvider(dir);
    await storage.init();
    await storage.settings.set("theme", { dark: true });
    expect(await storage.settings.get<{ dark: boolean }>("theme")).toEqual({ dark: true });
  });
});
