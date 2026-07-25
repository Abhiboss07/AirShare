/**
 * Message canonicalization and signing.
 *
 * Purpose: produce a deterministic byte representation of an envelope so that a
 * signature computed on one device verifies bit-for-bit on another, regardless
 * of JSON key ordering. Every authenticated message carries an Ed25519
 * signature over this canonical form (integrity + origin authenticity).
 *
 * Public API: `signEnvelope`, `verifyEnvelopeSignature`, `stableStringify`.
 */

import type { Envelope, MessageType } from "../types/messages.js";
import type { Identity } from "./identity.js";
import { Identity as IdentityClass } from "./identity.js";
import { toBase64Url, fromBase64Url } from "../utils/ids.js";

/** Deterministic JSON: object keys sorted recursively, no incidental whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Canonical bytes signed for an envelope: every field except `signature`.
 * Keeping `signature` out avoids a chicken-and-egg dependency.
 */
export function canonicalizeEnvelope<T extends MessageType>(envelope: Envelope<T>): Buffer {
  const { signature: _signature, ...rest } = envelope;
  void _signature;
  return Buffer.from(stableStringify(rest), "utf8");
}

/** Return a copy of the envelope with a valid `signature` filled in. */
export function signEnvelope<T extends MessageType>(
  identity: Identity,
  envelope: Envelope<T>,
): Envelope<T> {
  const unsigned: Envelope<T> = { ...envelope, signature: "" };
  const sig = identity.sign(canonicalizeEnvelope(unsigned));
  return { ...unsigned, signature: toBase64Url(sig) };
}

/** Verify an envelope's signature against a raw public key. */
export function verifyEnvelopeSignature(
  envelope: Envelope,
  senderPublicKeyRaw: string,
): boolean {
  if (!envelope.signature) return false;
  const unsigned: Envelope = { ...envelope, signature: "" };
  const data = canonicalizeEnvelope(unsigned);
  return IdentityClass.verify(data, fromBase64Url(envelope.signature), senderPublicKeyRaw);
}
