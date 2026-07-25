import { describe, it, expect } from "vitest";
import { AesGcmCipher, NoopCipher } from "../../src/transfer/entityCipher.js";
import { randomBytes } from "node:crypto";

describe("entity ciphers", () => {
  it("Noop passes bytes through", async () => {
    const c = new NoopCipher();
    const { ciphertext, meta } = await c.encrypt(Buffer.from("abc"));
    expect(meta.algorithm).toBe("none");
    expect((await c.decrypt(ciphertext, meta)).toString()).toBe("abc");
  });

  it("AES-GCM round-trips with a shared key", async () => {
    const key = randomBytes(32);
    const a = new AesGcmCipher(key);
    const b = new AesGcmCipher(key);
    const { ciphertext, meta } = await a.encrypt(Buffer.from("secret payload"));
    expect(ciphertext.toString()).not.toContain("secret");
    expect((await b.decrypt(ciphertext, meta)).toString()).toBe("secret payload");
  });

  it("AES-GCM rejects a wrong key and tampering", async () => {
    const a = new AesGcmCipher(randomBytes(32));
    const stranger = new AesGcmCipher(randomBytes(32));
    const { ciphertext, meta } = await a.encrypt(Buffer.from("x"));
    await expect(stranger.decrypt(ciphertext, meta)).rejects.toThrow();
    const tampered = Buffer.from(ciphertext);
    if (tampered.length) tampered[0]! ^= 0xff;
    await expect(a.decrypt(tampered, meta)).rejects.toThrow();
  });

  it("rejects a bad key length", () => {
    expect(() => new AesGcmCipher(Buffer.alloc(16))).toThrow();
  });
});
