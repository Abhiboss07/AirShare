/**
 * Short Authentication String (pairing verification code).
 *
 * Purpose: derive a short numeric code from both parties' ephemeral public keys
 * so that both devices independently compute the *same* code. Users compare it
 * out-of-band; a matching code proves there is no man-in-the-middle rewriting
 * the ephemeral keys, because a MITM would produce different keys and thus a
 * different code on each side.
 */

import { createHash } from "node:crypto";

export function computeShortAuthString(
  initiatorEphemeralRaw: string,
  responderEphemeralRaw: string,
  length: number,
): string {
  const digest = createHash("sha256")
    .update(Buffer.from(initiatorEphemeralRaw, "base64url"))
    .update(Buffer.from(responderEphemeralRaw, "base64url"))
    .digest();
  // Map the leading bytes to decimal digits deterministically.
  let code = "";
  for (let i = 0; i < length; i++) {
    code += (digest[i % digest.length]! % 10).toString();
  }
  return code;
}
