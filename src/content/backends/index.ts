/** Content backends: OS-agnostic contracts + in-memory and system implementations. */

export type {
  ClipboardBackend,
  FileBackend,
  FileStat,
  UrlOpener,
  CommandRunner,
} from "./types.js";
export {
  InMemoryClipboardBackend,
  InMemoryFileBackend,
  RecordingUrlOpener,
} from "./memory.js";
export { ExecCommandRunner } from "./command.js";
export {
  LinuxClipboardBackend,
  NodeFileBackend,
  XdgUrlOpener,
  detectClipboardBackend,
  WAYLAND_TOOL,
  XCLIP_TOOL,
  XSEL_TOOL,
  type ClipboardTool,
} from "./system.js";
