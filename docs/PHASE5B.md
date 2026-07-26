# Air Share — Phase 5B: Content Providers

Phase 5A hardened the runtime; Phase 5B makes it **do something visible**. Real
providers and sinks now produce and consume OS content, so a pinch on PC A grabs
the clipboard/text/image/file and a drop on PC B writes it. The first truly
usable end-to-end feature.

> Status: complete. 131 tests (was 113), including two real `AirShareNode`s
> moving PC A's clipboard text to PC B's clipboard, end-to-end encrypted. Demo:
> `npm run content:demo` (writes the real clipboard on Wayland/X11, in-memory
> otherwise).

The target workflow, now real:

```
PC A: pinch → clipboard text captured → ClipboardEntity → E2E encrypt → transfer
PC B: receive → decrypt → OS clipboard updated → user hits Ctrl+V → same text
```

---

## Design: OS access behind injectable backends

No new npm dependency (still `ws` + `bonjour-service`). Providers/sinks never
touch the OS directly — they call a **backend interface**, so the whole layer is
unit-testable with no real hardware, exactly like the camera-free vision layer.

```
provider/sink  →  ClipboardBackend / FileBackend / UrlOpener  →  { in-memory | native tool }
```

- **In-memory backends** (`InMemoryClipboardBackend`, `InMemoryFileBackend`,
  `RecordingUrlOpener`) — used by every test and the two-node integration.
- **System backends** shell out to native tools via an injected `CommandRunner`
  (an `execFile` wrapper): `LinuxClipboardBackend` detects Wayland
  (`wl-copy`/`wl-paste`) vs X11 (`xclip`/`xsel`); `NodeFileBackend`;
  `XdgUrlOpener` (`xdg-open`). Because the runner is injected, the OS backends are
  unit-tested by asserting the exact command + args **without spawning anything**.
- `detectClipboardBackend()` picks the best available tool, or falls back to
  in-memory with a logged note so headless environments still run.

`content/` is a sibling of vision/transfer/network: it implements the `transfer/`
plugin interfaces and touches the OS, but imports nothing from network or vision.

## Formalized plugin interfaces (non-breaking)

`EntityProvider`/`EntitySink` gained (all optional, so the Phase 3–5A mocks and
every existing test stayed green):

- `canProvide?(context)` — a fast pre-check consulted before `capture()`.
- `permissions?: PluginPermissions` — `{ read, write, requiresOsPermission,
  streaming, maxBytes }`, a declared capability descriptor (advisory this phase;
  will surface in the capability matrix later).
- declared `priority` — resolves ambiguity when several plugins match a grab.

## Providers & sinks

| Plugin | Entity | Priority | Notes |
| --- | --- | --- | --- |
| Clipboard | `ClipboardEntity` (text/html/image formats) | 100 | snapshots the clipboard; sink writes every format back |
| Text | `TextEntity` | 90 | text from a source in; write text out |
| Image | `ImageEntity` (base64) | 80 | PNG/JPEG/BMP/WebP carried by MIME |
| File | `FileEntity` (base64) | 70 | single file: read → bytes → write to a dest dir |
| Browser | browser-tab (url) | 60 | provider emits a URL; sink opens it via `UrlOpener` |

Each is a factory taking its backend by DI (e.g. `clipboardProvider(backend)`),
so tests inject in-memory backends and the demo injects detected real ones.
Priorities follow the requested scheme, so on any grab the clipboard provider
wins over text, text over image, and so on.

## Wiring — zero runtime/network change

`defaultContentPlugins(opts)` auto-detects backends and returns
`{ providers, sinks }` ready for the **existing** `attachTransferMesh({ providers,
sinks })` options (`mesh/index.ts` already registers them). No change to the
runtime, scheduler, cipher, or network layers — providers are pure plugins, which
was the entire point of proving the mesh and hardening the runtime first.

```ts
const { providers, sinks } = await defaultContentPlugins({ downloadDir: "~/Downloads" });
attachTransferMesh(node, { supports: ["transfer", "clipboard", "files"], providers, sinks });
```

## Testing

- **Backends:** in-memory round-trips; `LinuxClipboardBackend` command/args for
  Wayland and X11 (fake runner, no spawn); `detectClipboardBackend` branch logic.
- **Providers/sinks:** clipboard snapshot/restore, text, image (base64
  round-trip), file (read → dest dir), browser (opener called); provider
  **priority** ordering (clipboard beats text); `defaultContentPlugins` assembly.
- **Integration (2 real nodes):** PC A's clipboard text → PC B's clipboard, with
  the entity encrypted end-to-end and the ledger showing `completed` on both ends.

Run `npm test` (131). Demo `npm run content:demo`.

## Out of scope (later)

Screen/window capture, screen streaming, chunked/`sendStream` file streaming
(interface stays `NotImplemented`), multi-file/folder transfer, OCR/AI/
translation/voice, third-party plugin SDK, capability-matrix *enforcement*.

---

## Roadmap

```
Phase 1  ✅ Networking foundation
Phase 2  ✅ Vision & Gesture Engine
Phase 3  ✅ Transfer Runtime
Phase 4  ✅ Real Device Mesh
Phase 5A ✅ Production Runtime
Phase 5B ✅ Content Providers  ← you are here (first usable end-to-end feature)
Phase 6  ⬜ Huawei Experience (floating object, beam, device highlight, haptics, e2e)
```
