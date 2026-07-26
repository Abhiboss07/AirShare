/**
 * In-memory backends — the hardware-free implementations every test uses.
 *
 * They make the whole content layer provable end-to-end (including two real
 * nodes moving a clipboard entity) without touching a real clipboard, file
 * system or browser. The real OS backends live in `system.ts`.
 */

import path from "node:path";
import type {
  ClipboardBackend,
  FileBackend,
  FileStat,
  UrlOpener,
} from "./types.js";

export class InMemoryClipboardBackend implements ClipboardBackend {
  private text = "";
  private html: string | undefined;
  private image: { data: Buffer; mimeType: string } | undefined;

  constructor(seedText = "") {
    this.text = seedText;
  }

  async readText(): Promise<string> {
    return this.text;
  }
  async writeText(text: string): Promise<void> {
    this.text = text;
  }
  async readHtml(): Promise<string | undefined> {
    return this.html;
  }
  async writeHtml(html: string): Promise<void> {
    this.html = html;
  }
  async readImage(): Promise<{ data: Buffer; mimeType: string } | undefined> {
    return this.image ? { data: Buffer.from(this.image.data), mimeType: this.image.mimeType } : undefined;
  }
  async writeImage(data: Buffer, mimeType: string): Promise<void> {
    this.image = { data: Buffer.from(data), mimeType };
  }
}

/** A virtual filesystem keyed by path — used for file-provider tests. */
export class InMemoryFileBackend implements FileBackend {
  private readonly files = new Map<string, Buffer>();

  constructor(seed: Record<string, Buffer | string> = {}) {
    for (const [p, v] of Object.entries(seed)) {
      this.files.set(p, Buffer.isBuffer(v) ? v : Buffer.from(v));
    }
  }

  async readFile(p: string): Promise<Buffer> {
    const data = this.files.get(p);
    if (!data) throw new Error(`no such file: ${p}`);
    return Buffer.from(data);
  }
  async writeFile(p: string, data: Buffer): Promise<void> {
    this.files.set(p, Buffer.from(data));
  }
  async stat(p: string): Promise<FileStat> {
    const data = this.files.get(p);
    if (!data) throw new Error(`no such file: ${p}`);
    return { name: path.basename(p), sizeBytes: data.length };
  }
  /** Test helper: read back what a sink wrote. */
  peek(p: string): Buffer | undefined {
    const data = this.files.get(p);
    return data ? Buffer.from(data) : undefined;
  }
}

/** Records opened URLs instead of launching a browser. */
export class RecordingUrlOpener implements UrlOpener {
  readonly opened: string[] = [];
  async open(url: string): Promise<void> {
    this.opened.push(url);
  }
}
