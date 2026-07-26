# Air Share — Phase 6: Huawei Experience (the visible loop)

Phases 1–5B built a headless, end-to-end pipeline. Phase 6 makes it **see-and-
feel**: a live camera with a hand overlay, a floating object that follows your
pinch, a glowing target device, and a beam that carries the object across on
release — all driving the **real** mesh underneath.

> Status: first increment complete. 133 tests (was 131): a headless bridge
> integration test runs the *whole* loop (scripted landmarks → real vision →
> grab → E2E-encrypt → mesh → PC-B clipboard) with no browser or camera. Live
> demo: `npm run experience:demo`.

```
Browser (thin client)                     Node bridge (real system)
────────────────────────                  ─────────────────────────────
camera → MediaPipe ── landmarks ──▶ VisionEngine → TransferRuntime → mesh (A→B)
   ▲                                          │            │
   └────── curated bus events ◀───────────────┴── clipboard sink (PC-B)
   render: hand overlay, floating
   object, target glow, beam
```

## Architecture — web thin-client + Node bridge

The mesh (`ws`/`bonjour`) is Node-only, so the browser can't run it. Instead:

- **Browser** (`web/`) owns *only* the camera, MediaPipe hand tracking, and
  rendering. It streams raw landmark results up and animates the events sent
  back. No mesh, crypto or transfer logic lives here.
- **Node bridge** (`src/bridge/`) — `ExperienceBridge` owns two real
  `AirShareNode`s on loopback (PC-A camera-driven, PC-B receiver), a
  `VisionEngine` fed by a `MediaPipeLandmarkSource`, and the transfer runtime with
  a `clipboardProvider`/`clipboardSink`. It serves the client over `http`, relays
  a curated slice of both event buses over WebSocket, and routes inbound landmark
  frames into A's vision.

This is exactly the split `mediapipeAdapter.ts` always anticipated (the renderer
owns the camera loop and calls `pushResult`). The bridge is a **composition seam**
like `mesh/`: it imports core/vision/mesh/content and nothing imports it. **No
runtime, mesh, vision, content or network code changed** for Phase 6 — it's all
reuse.

## What you see

- Live camera with a mirrored **hand skeleton** overlay and a gesture **HUD**
  (gesture, confidence, holding, resolved target).
- On pinch (`hand:grab`) a **📄 floating object** appears and follows your pinch
  midpoint (thumb tip ↔ index tip), rendered locally for smoothness.
- The **PC-B tile glows** when it's the resolved target (`hand:target-changed`).
- On release (`hand:release`) the object **flies to PC-B** and a **beam** fires
  (`transfer:started`); on `transfer:completed` PC-B pulses and its clipboard text
  updates — the real, E2E-encrypted entity that just crossed the mesh.

Motion is driven by the browser's own landmarks (low latency); *state* (grab,
target, transfer) is authoritative from the bridge.

## Tooling & assets

- `@mediapipe/tasks-vision` (dependency) for hand tracking; `esbuild` (dev) bundles
  `web/client.ts` → `web/dist/client.js`.
- `npm run ui:build` bundles the client, vendors the MediaPipe wasm from
  `node_modules` into `web/vendor/`, and fetches `hand_landmarker.task` (~7 MB)
  once. `web/dist/` and `web/vendor/` are git-ignored (not committed).
- `web/` is excluded from the Node `tsc` build and has its own DOM `tsconfig`.

## Running it

```bash
npm run experience:demo         # builds the UI, starts the bridge, prints a URL
# open http://localhost:4319, allow the camera
# pinch → the 📄 follows your finger → release toward PC-B → it lands in PC-B's clipboard
```

`AIRSHARE_UI_PORT` and `AIRSHARE_CLIP` override the port and seeded text.

## Testing

- **Headless bridge integration** (`test/bridge/bridge.test.ts`): a WebSocket
  client streams scripted MediaPipe landmarks (a pinch→hold→release), and we
  assert the bridge relays `hand:grab`, the transfer fires, and **PC-B's clipboard
  receives PC-A's text** — the entire loop, no browser or camera. Stable across
  repeated runs.
- `npm test` → 133 green; `npm run typecheck` + `tsc -p web/tsconfig.json` clean.

## Honest limits / next

The two-panel demo runs both nodes in one process (loopback); a genuine
two-machine run is the "single device + real peer" variant (a small follow-up).
Vision quality is MediaPipe's (lighting/hand-visibility matter). No native
always-on-top overlay yet (that's an Electron wrap, deferred). Richer
hover-preview, multi-hand choreography and sound/haptics are future Phase-6
iterations; screen/window sharing and streaming are Phase 7.

---

## Roadmap

```
Phase 1  ✅ Networking foundation
Phase 2  ✅ Vision & Gesture Engine
Phase 3  ✅ Transfer Runtime
Phase 4  ✅ Real Device Mesh
Phase 5A ✅ Production Runtime
Phase 5B ✅ Content Providers
Phase 6  ✅ Huawei Experience — the visible loop  ← you are here
Phase 7  ⬜ Real screen sharing (window transfer, screen region, streaming)
Phase 8  ⬜ AI layer (OCR, translation, smart actions, plugin SDK)
Phase 9  ⬜ Cross-platform packaging (Windows, Linux, Android, macOS)
```
