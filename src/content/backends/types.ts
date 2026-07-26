/**
 * Backend contracts for content providers.
 *
 * Purpose: keep the providers/sinks OS-agnostic. A provider says "read the
 * clipboard"; whether that means `wl-paste`, `xclip`, an Android bridge, or an
 * in-memory buffer is a backend concern injected at composition time. This is
 * why the whole content layer stays unit-testable with no real hardware — the
 * same trick the vision layer uses with `LandmarkSource`.
 */

/** Reads/writes the system clipboard. Image/HTML methods are optional. */
export interface ClipboardBackend {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  readImage?(): Promise<{ data: Buffer; mimeType: string } | undefined>;
  writeImage?(data: Buffer, mimeType: string): Promise<void>;
  readHtml?(): Promise<string | undefined>;
  writeHtml?(html: string): Promise<void>;
}

export interface FileStat {
  name: string;
  sizeBytes: number;
}

/** Reads/writes files. */
export interface FileBackend {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  stat(path: string): Promise<FileStat>;
}

/** Opens a URL in the system's default handler. */
export interface UrlOpener {
  open(url: string): Promise<void>;
}

/**
 * Runs an external command. Injected so the OS backends can be unit-tested by
 * asserting the command + args without ever spawning a process. `input` is
 * written to stdin (for e.g. `wl-copy`); resolves with captured stdout.
 */
export interface CommandRunner {
  run(command: string, args: string[], input?: Buffer): Promise<Buffer>;
  /** Whether `command` exists on PATH (used for backend detection). */
  exists(command: string): Promise<boolean>;
}
