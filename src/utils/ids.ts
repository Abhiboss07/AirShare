/**
 * Identifier and encoding helpers.
 *
 * Purpose: centralise generation of message ids and encoding conversions so the
 * rest of the code never reaches for `crypto` directly for these primitives.
 */

import { randomUUID, randomBytes, randomInt } from "node:crypto";

/** Globally-unique message id (UUID v4). */
export function newMessageId(): string {
  return randomUUID();
}

/** Base64url encode without padding — safe for JSON, URLs and TXT records. */
export function toBase64Url(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/** A cryptographically-random nonce, base64url-encoded. */
export function newNonce(bytes = 16): string {
  return toBase64Url(randomBytes(bytes));
}

/** Numeric verification code of the requested length, e.g. "042915". */
export function newVerificationCode(length: number): string {
  let code = "";
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString();
  return code;
}
