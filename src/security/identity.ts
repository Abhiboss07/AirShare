/**
 * Long-term device identity (Ed25519).
 *
 * Purpose: a device's identity is an Ed25519 signing keypair generated once and
 * persisted. The device id is the SHA-256 fingerprint of the public key, so an
 * id is cryptographically bound to a key nobody else holds — spoofing an id
 * requires forging Ed25519 signatures.
 *
 * Public API: `Identity.generate()`, `Identity.fromKeyMaterial()`,
 * `identity.sign()`, plus static `verify()` / `deviceIdFor()`. Serialization
 * for storage goes through `export()` / the `ExportedIdentity` shape.
 *
 * Future integration: the same signing key authenticates session handshakes
 * (see session.ts) and every message (see crypto.ts). File-transfer manifests
 * in later phases can be signed with the same primitive.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createHash,
  type KeyObject,
} from "node:crypto";
import { toBase64Url } from "../utils/ids.js";

export interface ExportedIdentity {
  /** PKCS8 PEM of the private key. Sensitive — persisted with 0600 perms. */
  privateKeyPem: string;
  /** Base64url raw 32-byte public key. */
  publicKeyRaw: string;
  deviceId: string;
}

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("public key JWK missing 'x'");
  return Buffer.from(jwk.x, "base64url");
}

/** Import an Ed25519 public key from its raw 32-byte form. */
export function importEd25519PublicKey(raw: Buffer | string): KeyObject {
  const x = typeof raw === "string" ? raw : toBase64Url(raw);
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x },
    format: "jwk",
  });
}

/** Derive the device id (SHA-256 fingerprint, base64url) for a raw public key. */
export function deviceIdFor(rawPublicKeyB64: string): string {
  const digest = createHash("sha256").update(Buffer.from(rawPublicKeyB64, "base64url")).digest();
  return toBase64Url(digest);
}

export class Identity {
  private constructor(
    private readonly privateKey: KeyObject,
    public readonly publicKey: KeyObject,
    public readonly publicKeyRaw: string,
    public readonly deviceId: string,
  ) {}

  /** Create a brand-new identity with a fresh keypair. */
  static generate(): Identity {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return Identity.fromKeyObjects(privateKey, publicKey);
  }

  /** Rehydrate an identity from previously exported key material. */
  static fromKeyMaterial(material: ExportedIdentity): Identity {
    const privateKey = createPrivateKey({ key: material.privateKeyPem, format: "pem" });
    const publicKey = createPublicKey(privateKey);
    const identity = Identity.fromKeyObjects(privateKey, publicKey);
    if (identity.deviceId !== material.deviceId) {
      throw new Error("stored deviceId does not match derived key fingerprint");
    }
    return identity;
  }

  private static fromKeyObjects(privateKey: KeyObject, publicKey: KeyObject): Identity {
    const raw = toBase64Url(rawPublicKey(publicKey));
    return new Identity(privateKey, publicKey, raw, deviceIdFor(raw));
  }

  /** Sign arbitrary bytes with this device's private key. */
  sign(data: Buffer): Buffer {
    return edSign(null, data, this.privateKey);
  }

  /** Verify a signature against a raw public key (static, no instance needed). */
  static verify(data: Buffer, signature: Buffer, rawPublicKeyB64: string): boolean {
    try {
      return edVerify(null, data, importEd25519PublicKey(rawPublicKeyB64), signature);
    } catch {
      return false;
    }
  }

  export(): ExportedIdentity {
    return {
      privateKeyPem: this.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyRaw: this.publicKeyRaw,
      deviceId: this.deviceId,
    };
  }
}
