/**
 * System (OS) backends — real clipboard/file/URL access by shelling out.
 *
 * No new npm dependency: the clipboard backend drives native tools it detects
 * (`wl-clipboard` on Wayland, `xclip`/`xsel` on X11) through an injected
 * `CommandRunner`. `detectClipboardBackend` picks the best available tool, or
 * falls back to the in-memory backend (with a logged note) so headless
 * environments still run.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ClipboardBackend,
  CommandRunner,
  FileBackend,
  FileStat,
  UrlOpener,
} from "./types.js";
import { InMemoryClipboardBackend } from "./memory.js";
import type { Logger } from "../../utils/logger.js";

interface Cmd {
  cmd: string;
  args: string[];
}

/** How to drive one clipboard tool (Wayland or X11). */
export interface ClipboardTool {
  name: string;
  pasteText: Cmd;
  copyText: Cmd;
  pasteImage?: Cmd;
  copyImage?: (mimeType: string) => Cmd;
  pasteHtml?: Cmd;
  copyHtml?: Cmd;
}

export const WAYLAND_TOOL: ClipboardTool = {
  name: "wl-clipboard",
  pasteText: { cmd: "wl-paste", args: ["--no-newline", "--type", "text/plain"] },
  copyText: { cmd: "wl-copy", args: ["--type", "text/plain"] },
  pasteImage: { cmd: "wl-paste", args: ["--type", "image/png"] },
  copyImage: (mimeType) => ({ cmd: "wl-copy", args: ["--type", mimeType] }),
  pasteHtml: { cmd: "wl-paste", args: ["--type", "text/html"] },
  copyHtml: { cmd: "wl-copy", args: ["--type", "text/html"] },
};

export const XCLIP_TOOL: ClipboardTool = {
  name: "xclip",
  pasteText: { cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
  copyText: { cmd: "xclip", args: ["-selection", "clipboard", "-i"] },
  pasteImage: { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
  copyImage: (mimeType) => ({ cmd: "xclip", args: ["-selection", "clipboard", "-t", mimeType, "-i"] }),
  pasteHtml: { cmd: "xclip", args: ["-selection", "clipboard", "-t", "text/html", "-o"] },
  copyHtml: { cmd: "xclip", args: ["-selection", "clipboard", "-t", "text/html", "-i"] },
};

/** Text-only fallback. */
export const XSEL_TOOL: ClipboardTool = {
  name: "xsel",
  pasteText: { cmd: "xsel", args: ["--clipboard", "--output"] },
  copyText: { cmd: "xsel", args: ["--clipboard", "--input"] },
};

/** A ClipboardBackend that drives a native tool via a CommandRunner. */
export class LinuxClipboardBackend implements ClipboardBackend {
  constructor(
    private readonly tool: ClipboardTool,
    private readonly runner: CommandRunner,
  ) {}

  get toolName(): string {
    return this.tool.name;
  }

  async readText(): Promise<string> {
    const out = await this.runner.run(this.tool.pasteText.cmd, this.tool.pasteText.args);
    return out.toString("utf8");
  }

  async writeText(text: string): Promise<void> {
    await this.runner.run(this.tool.copyText.cmd, this.tool.copyText.args, Buffer.from(text, "utf8"));
  }

  async readImage(): Promise<{ data: Buffer; mimeType: string } | undefined> {
    if (!this.tool.pasteImage) return undefined;
    const data = await this.runner.run(this.tool.pasteImage.cmd, this.tool.pasteImage.args);
    return data.length ? { data, mimeType: "image/png" } : undefined;
  }

  async writeImage(data: Buffer, mimeType: string): Promise<void> {
    if (!this.tool.copyImage) throw new Error(`${this.tool.name} cannot write images`);
    const { cmd, args } = this.tool.copyImage(mimeType);
    await this.runner.run(cmd, args, data);
  }

  async readHtml(): Promise<string | undefined> {
    if (!this.tool.pasteHtml) return undefined;
    const out = await this.runner.run(this.tool.pasteHtml.cmd, this.tool.pasteHtml.args);
    return out.length ? out.toString("utf8") : undefined;
  }

  async writeHtml(html: string): Promise<void> {
    if (!this.tool.copyHtml) throw new Error(`${this.tool.name} cannot write html`);
    await this.runner.run(this.tool.copyHtml.cmd, this.tool.copyHtml.args, Buffer.from(html, "utf8"));
  }
}

/** Real filesystem backend. */
export class NodeFileBackend implements FileBackend {
  readFile(p: string): Promise<Buffer> {
    return fs.readFile(p);
  }
  async writeFile(p: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }
  async stat(p: string): Promise<FileStat> {
    const s = await fs.stat(p);
    return { name: path.basename(p), sizeBytes: s.size };
  }
}

/** Opens URLs with `xdg-open` (Linux). */
export class XdgUrlOpener implements UrlOpener {
  constructor(private readonly runner: CommandRunner) {}
  async open(url: string): Promise<void> {
    await this.runner.run("xdg-open", [url]);
  }
}

/**
 * Choose the best available real clipboard backend, or fall back to in-memory.
 * Prefers Wayland when a compositor is present, then X11 tools.
 */
export async function detectClipboardBackend(
  runner: CommandRunner,
  logger?: Logger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClipboardBackend> {
  if (env["WAYLAND_DISPLAY"] && (await runner.exists("wl-copy"))) {
    logger?.info("clipboard: using wl-clipboard (Wayland)");
    return new LinuxClipboardBackend(WAYLAND_TOOL, runner);
  }
  if (env["DISPLAY"] && (await runner.exists("xclip"))) {
    logger?.info("clipboard: using xclip (X11)");
    return new LinuxClipboardBackend(XCLIP_TOOL, runner);
  }
  if (env["DISPLAY"] && (await runner.exists("xsel"))) {
    logger?.info("clipboard: using xsel (X11, text only)");
    return new LinuxClipboardBackend(XSEL_TOOL, runner);
  }
  logger?.warn("clipboard: no native tool found; using in-memory backend");
  return new InMemoryClipboardBackend();
}
