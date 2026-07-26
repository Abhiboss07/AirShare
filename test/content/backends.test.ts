import { describe, it, expect } from "vitest";
import {
  InMemoryClipboardBackend,
  InMemoryFileBackend,
  LinuxClipboardBackend,
  WAYLAND_TOOL,
  XCLIP_TOOL,
  detectClipboardBackend,
  type CommandRunner,
} from "../../src/content/index.js";

/** A CommandRunner that records calls and never spawns a process. */
class FakeRunner implements CommandRunner {
  readonly calls: { cmd: string; args: string[]; input?: Buffer }[] = [];
  constructor(
    private readonly responses: Record<string, Buffer> = {},
    private readonly present = new Set<string>(),
  ) {}
  async run(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
    this.calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
    return this.responses[cmd] ?? Buffer.alloc(0);
  }
  async exists(cmd: string): Promise<boolean> {
    return this.present.has(cmd);
  }
}

describe("in-memory backends", () => {
  it("round-trips clipboard text, html and image", async () => {
    const cb = new InMemoryClipboardBackend();
    await cb.writeText("hello");
    await cb.writeHtml("<b>hi</b>");
    await cb.writeImage(Buffer.from([1, 2, 3]), "image/png");
    expect(await cb.readText()).toBe("hello");
    expect(await cb.readHtml()).toBe("<b>hi</b>");
    expect((await cb.readImage())?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("reads, writes and stats files", async () => {
    const fb = new InMemoryFileBackend({ "/a/b.txt": "data" });
    expect((await fb.readFile("/a/b.txt")).toString()).toBe("data");
    expect(await fb.stat("/a/b.txt")).toEqual({ name: "b.txt", sizeBytes: 4 });
    await fb.writeFile("/out/c.bin", Buffer.from("xy"));
    expect(fb.peek("/out/c.bin")?.toString()).toBe("xy");
    await expect(fb.readFile("/missing")).rejects.toThrow();
  });
});

describe("LinuxClipboardBackend (no spawn)", () => {
  it("reads text via the tool's paste command", async () => {
    const runner = new FakeRunner({ "wl-paste": Buffer.from("copied text") });
    const cb = new LinuxClipboardBackend(WAYLAND_TOOL, runner);
    expect(await cb.readText()).toBe("copied text");
    expect(runner.calls[0]).toEqual({
      cmd: "wl-paste",
      args: ["--no-newline", "--type", "text/plain"],
    });
  });

  it("writes text by piping stdin to the copy command", async () => {
    const runner = new FakeRunner();
    const cb = new LinuxClipboardBackend(WAYLAND_TOOL, runner);
    await cb.writeText("send me");
    expect(runner.calls[0]!.cmd).toBe("wl-copy");
    expect(runner.calls[0]!.args).toEqual(["--type", "text/plain"]);
    expect(runner.calls[0]!.input?.toString()).toBe("send me");
  });

  it("returns undefined for an empty clipboard image", async () => {
    const runner = new FakeRunner({ xclip: Buffer.alloc(0) });
    const cb = new LinuxClipboardBackend(XCLIP_TOOL, runner);
    expect(await cb.readImage()).toBeUndefined();
  });
});

describe("detectClipboardBackend", () => {
  const silent = undefined;
  it("prefers wl-clipboard on Wayland when present", async () => {
    const runner = new FakeRunner({}, new Set(["wl-copy"]));
    const cb = await detectClipboardBackend(runner, silent, { WAYLAND_DISPLAY: "wayland-0" });
    expect(cb).toBeInstanceOf(LinuxClipboardBackend);
    expect((cb as LinuxClipboardBackend).toolName).toBe("wl-clipboard");
  });

  it("falls back to xclip on X11", async () => {
    const runner = new FakeRunner({}, new Set(["xclip"]));
    const cb = await detectClipboardBackend(runner, silent, { DISPLAY: ":0" });
    expect((cb as LinuxClipboardBackend).toolName).toBe("xclip");
  });

  it("uses the in-memory backend when no tool exists", async () => {
    const runner = new FakeRunner({}, new Set());
    const cb = await detectClipboardBackend(runner, silent, {});
    expect(cb).toBeInstanceOf(InMemoryClipboardBackend);
  });
});
