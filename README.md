# Air Share — Phase 1: Foundation & Networking

Air Share is a gesture-inspired, local-network transfer system (à la Huawei Super
Device / AirDrop). **Phase 1 builds only the networking foundation** every later
phase depends on: secure automatic discovery, pairing, authenticated encrypted
messaging, heartbeats and reconnection. There is deliberately **no** gesture,
camera, clipboard or file-transfer code yet — those plug into this foundation
later without changing it.

> Status: **Phases 1–4 complete.** 99 automated tests passing, including a real
> two-node WebSocket handshake, the full gesture pipeline, and a
> **gesture→grab→encrypt→real-mesh-transfer→drop** flow between two live nodes.
> Docs: [`PHASE2`](docs/PHASE2.md) · [`PHASE3`](docs/PHASE3.md) ·
> [`PHASE4`](docs/PHASE4.md). Milestone demo: `npm run mesh:demo`.

---

## Quick start

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest: unit + integration
npm run dev          # run the reference CLI with hot reload (tsx)
node dist/index.js   # run the built node
```

Run two nodes on the same LAN and they will discover each other over mDNS. On
first contact each side is prompted to confirm a 6-digit verification code; after
that they are trusted and reconnect automatically. For headless/testing use,
`AIRSHARE_AUTO_PAIR=1` auto-approves.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `AIRSHARE_DEVICE_NAME` | Display name advertised to peers |
| `AIRSHARE_PORT` | TCP port for the WebSocket server (default: ephemeral) |
| `AIRSHARE_DATA_DIR` | Where identity/keys/trust are persisted |
| `AIRSHARE_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `AIRSHARE_AUTO_PAIR` | `1` to auto-approve pairing (non-interactive) |

---

## Architecture at a glance

```
        ┌──────────────────────────── AirShareNode (composition root) ────────────────────────────┐
        │                                                                                          │
  mDNS  │   Discovery ──found/lost──►┌───────────┐         ┌──────────────────┐                    │
 ◄──────┼──────────────────────────►│           │         │  DeviceRegistry  │  (authoritative     │
        │                           │           │◄───────►│   status/addrs)  │   device state)     │
        │   ConnectionManager ─dial─►│ EventBus  │         └──────────────────┘                    │
        │   (auto-connect/backoff)   │  (typed)  │         ┌──────────────────┐                    │
        │                           │           │◄───────►│  PairingService  │  (trust policy)     │
   TCP  │   WebSocketTransport ─────►│           │         └──────────────────┘                    │
 ◄──────┼───► PeerConnection ×N ────►└───────────┘                  │                               │
   wss  │      (handshake, session,                                 ▼                               │
        │       heartbeat)                             Security: Identity(Ed25519),                 │
        │                                              Session(X25519+AES-256-GCM),                 │
        │   Storage (JSON files): identity · trusted devices · settings   TrustManager              │
        └──────────────────────────────────────────────────────────────────────────────────────────┘
```

Every module talks through the **typed EventBus** rather than to each other
directly. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full data-flow
and sequence diagrams, and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the
threat model, security decisions and a critical review.

---

## Folder structure

```
src/
  config/      Typed config, defaults (every magic number lives here), loader+validator
  types/       Domain contracts: device, wire messages, event map
  utils/       Structured logger, id/encoding helpers, async/backoff primitives
  events/      Typed in-process EventBus (the backbone)
  security/    Identity (Ed25519), Session (X25519+AES-GCM), signing, SAS, TrustManager
  storage/     StorageProvider interface + atomic JSON-file implementation
  network/     Protocol codec, mDNS discovery, WebSocket transport, PeerConnection FSM
  services/    DeviceRegistry, PairingService, ConnectionManager
  vision/      (Phase 2) geometry, smoothing, detectors, swipe, state machine, engine
  transfer/    (Phase 3) entities, state machine, cipher, registry, scheduler, runtime
  mesh/        (Phase 4) mesh transport, messenger, capabilities — bridges net + transfer
  core/        AirShareNode — composition root & public facade
  index.ts     Library exports + reference CLI
scripts/
  vision-demo.ts    Camera-free gesture pipeline demo (npm run vision:demo)
  transfer-demo.ts  Two-runtime gesture→transfer→drop demo (npm run transfer:demo)
  mesh-demo.ts      Two REAL nodes: gesture→secure-mesh→drop + latency (npm run mesh:demo)
test/
  unit/        crypto, identity, protocol, config, storage, backoff/SAS, registry, reconnect
  integration/ two real nodes: handshake → pairing → encrypted message → heartbeat
  vision/      geometry, detectors, smoothing, swipe, state machine, engine, adapter
  transfer/    state machine, entity manager, cipher, registry, end-to-end runtime
  mesh/        scheduler, capability negotiation, two-real-node transfer + latency
```

Vision, transfer and network import nothing from each other — they meet only on
the `EventBus` and behind interfaces (`ITransport`, `ITransferTransport`). The
`mesh/` layer is the single composition seam that bridges networking and transfer.

---

## Public API (embedding Air Share)

```ts
import { AirShareNode } from "air-share";

const node = new AirShareNode({ config: { deviceName: "Laptop" } });

node.on("pair:request", ({ device, verificationCode, accept, reject }) => {
  // show `verificationCode` to the user; call accept() or reject()
});
node.on("device:connected", ({ device }) => console.log("up:", device.identity.name));
node.on("message:received", ({ from, envelope }) => console.log(from, envelope.payload));

await node.start();
node.sendTo(peerId, "channel-name", { any: "json" });
await node.stop();
```

The full event catalogue is in [`src/types/events.ts`](src/types/events.ts).

---

## Testing

`npm test` runs Vitest. Coverage spans:

- **Crypto** — Ed25519 sign/verify, tamper & wrong-key rejection, X25519+AES-GCM
  round-trip, tamper/stranger rejection, canonicalization determinism.
- **Identity** — id↔key binding, export/import round-trip, mismatch rejection.
- **Protocol** — envelope validation (version/type/shape), plaintext & encrypted
  framing, oversized/malformed rejection.
- **Config / Storage** — merge+validation; identity/trust/settings persistence.
- **Services** — reconnection backoff scheduling, registry state machine.
- **Integration** — two live nodes pair, persist trust, exchange an encrypted
  message and heartbeat; and a declined-pairing path.

---

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Networking foundation (secure discovery, pairing, encrypted messaging, heartbeat) | ✅ |
| 2 | Vision & Gesture Engine (MediaPipe landmarks → `gesture:*` events) | ✅ |
| 3 | Transfer Runtime (`TransferableEntity` lifecycle, action pipeline, plugins, virtual hand) | ✅ |
| 4 | Real Device Mesh (mesh transport over Phase-1, scheduler, capabilities, latency) | ✅ |
| 5 | Content Providers (clipboard, image, file, text, screen, window, browser) | ⬜ |
| 6 | Huawei Experience (floating object, beam, device highlight, hover preview, haptics, latency, e2e) | ⬜ |

Each phase is additive and meets the others only on the `EventBus` / behind
interfaces. The distributed runtime is now proven end-to-end, so every Phase-5
content provider is a small plugin — no networking changes required.
