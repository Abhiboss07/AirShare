# Air Share — Threat Model, Security Decisions & Critical Review (Phase 1)

## 1. Assets

| Asset | Why it matters |
| --- | --- |
| Device private key (Ed25519) | Root of the device's identity; compromise = full impersonation |
| Trusted-device set | Governs who may connect automatically |
| Session keys (AES-256-GCM) | Confidentiality/integrity of live traffic |
| User content (future phases) | The whole point of the product |

## 2. Adversaries & assumptions

- **Passive LAN sniffer** — reads all Wi-Fi/LAN traffic.
- **Active on-path attacker (MITM)** — can inject, drop, replay, and attempt to
  relay/rewrite the handshake.
- **Rogue device on the same network** — speaks the protocol and tries to pair or
  impersonate a known device.
- Out of scope for Phase 1: a compromised host OS, physical access to unlocked
  devices, and side-channel/timing attacks on the crypto primitives (we rely on
  Node's audited `crypto`).

## 3. Threats → mitigations

| # | Threat | Mitigation |
| --- | --- | --- |
| T1 | **Eavesdropping** on messages | All post-handshake frames use AES-256-GCM with per-message random IVs and direction-separated keys. |
| T2 | **Device spoofing** (claim another's id) | `deviceId ≡ SHA-256(publicKey)`; HELLO is Ed25519-signed by that key. No private key ⇒ no valid HELLO for that id. |
| T3 | **Man-in-the-middle** on key exchange | Ephemeral X25519 keys are carried inside *signed* HELLOs (authenticated ECDH). The SAS is derived from both ephemeral keys, so a MITM yields mismatched codes the user can detect. |
| T4 | **Replay** of a captured message | Envelope `timestamp` is checked against `clockSkewToleranceMs`; GCM auth tag + fresh IVs prevent ciphertext reuse; ephemeral session keys make cross-session replay useless. |
| T5 | **Unauthorized first contact** | Unknown devices require explicit user approval (`requirePairingApproval`) before trust is stored. |
| T6 | **Trusted-id takeover with a new key** | On reconnect, a device claiming a trusted id must present the *exact stored public key* (`matchesStoredKey`), else it is rejected. |
| T7 | **Malformed / oversized / downgrade packets** | `validateEnvelope` enforces shape; `maxFrameBytes` caps size; unknown/old `version` ⇒ reject + close. |
| T8 | **Forged application messages** | Each frame is signature-verified against the paired public key and its `sender` field must match; failures are dropped. |
| T9 | **Resource exhaustion via half-open handshakes** | Per-connection handshake timeout closes stalled links; heartbeat reaps dead ones. |
| T10 | **Tampering in transit** | GCM auth tag rejects any bit-flip; canonical-form signatures reject field tampering. |

## 4. Security decisions & rationale

1. **Application-layer authenticated encryption instead of (only) TLS.**
   Self-signed TLS on a LAN encrypts the pipe but does not by itself prove *which
   device* is on the other end without certificate pinning. Air Share already
   needs identity-bound crypto for pairing, so an X25519 ECDH authenticated by
   each side's long-term Ed25519 key delivers encryption **and** mutual
   authentication in one mechanism — and it works identically over future binary
   / WebRTC transports. TLS can still wrap the socket later as defense in depth.

2. **Ed25519 + X25519 + AES-256-GCM + HKDF-SHA256.** Modern, fast, misuse-
   resistant primitives available natively in Node `crypto` (no third-party crypto
   dependency to audit).

3. **Ephemeral session keys ⇒ forward secrecy.** Compromise of a long-term key
   does not decrypt previously recorded sessions.

4. **`ws` over Socket.IO.** We need full control of binary framing (Phase 2 file
   streaming) and a crypto-aware handshake/heartbeat; Socket.IO's connection-level
   heartbeat/reconnect would fight our application-level logic.

5. **JSON-file storage with `0600` secrets and atomic writes.** Zero native
   dependencies (portable to all target OSes) and swappable for SQLite behind the
   `StorageProvider` interface.

---

## 5. Critical review — known weaknesses & how to harden

Phase 1 is an industrial-grade *foundation*, not a finished secure product. Honest
gaps and the intended fixes:

| Area | Weakness | Planned refactor |
| --- | --- | --- |
| **SAS auto-approval** | Trusted devices skip the SAS comparison entirely; trust-on-first-use (TOFU) means the *first* pairing is only as safe as the user actually comparing the code. | Optional QR-code pairing (Phase 5) to bootstrap trust out-of-band; show SAS in UI with a mandatory confirm. |
| **No message ordering / dedup** | `messageId` is generated but not yet used to reject duplicates or enforce ordering; replay is bounded only by the (wide) clock-skew window. | Per-session monotonically increasing counter + seen-id LRU; tighten skew and add a nonce cache. |
| **Backpressure / flow control** | A single 16 MiB frame cap is the only limit; no rate limiting or per-peer quotas — a rogue peer could spam. | Token-bucket rate limiter per connection; chunked, backpressure-aware streaming for Phase 2 transfers. |
| **Handshake DoS** | Unauthenticated peers can open sockets and force ECDH work before the timeout fires. | Cheap proof-of-work / connection cap per source IP; lazy ECDH after a cookie exchange. |
| **Clock dependence** | Replay defense relies on loosely-synced clocks. | Prefer the session nonce/counter as the primary anti-replay mechanism; treat timestamp as advisory. |
| **mDNS trust** | Discovery is unauthenticated (as designed) but a flood of fake advertisements could grow the registry. | Cap registry size; rate-limit `device:found`; the handshake already rejects bad identities. |
| **Scale of the registry/event bus** | In-memory maps and synchronous emit are fine for tens of devices, not thousands. | Shard the registry; move to an async event queue if a node ever fans out to many peers. |
| **Single-writer JSON store** | Concurrent `AirShareNode` instances sharing one `dataDir` could race despite atomic file swaps. | The SQLite provider (already interface-ready) gives real transactions. |
| **Key rotation / revocation** | `TrustManager.revoke` exists, but there is no rotation protocol or revocation propagation. | Signed key-rotation messages + a revocation list synced between paired devices. |

### Scalability note
The event-driven design and the `PeerConnection`↔transport separation mean the
above are *additive* changes: rate limiting, ordering and streaming slot into
`PeerConnection`/`MessageCodec`; a SQLite store slots behind `StorageProvider`;
none touch the crypto or the public `AirShareNode` API. That is the intended
payoff of Phase 1's layering.

---

## 6. Testing strategy

- **Unit** — deterministic coverage of every security primitive (sign/verify,
  session round-trip, tamper/stranger rejection, id binding, SAS symmetry),
  protocol validation, config merge/validation, storage repositories, and pure
  logic (backoff, registry FSM, reconnection scheduling with fake timers).
- **Integration** — two real `AirShareNode`s over loopback WebSockets exercise the
  full path: signed handshake → key agreement → mutual pairing → trust
  persistence → encrypted application message → heartbeat, plus a declined-pairing
  teardown. mDNS is disabled here for determinism; discovery is smoke-tested via
  the CLI.
- **Future** — property-based fuzzing of the codec, an adversarial peer harness
  (bad signatures, replays, oversized frames), and a chaos test that drops sockets
  to assert reconnection/backoff behavior.
