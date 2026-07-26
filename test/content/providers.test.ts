import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/utils/logger.js";
import { PluginRegistry } from "../../src/transfer/index.js";
import {
  InMemoryClipboardBackend,
  InMemoryFileBackend,
  RecordingUrlOpener,
  clipboardProvider,
  clipboardSink,
  textProvider,
  clipboardTextSink,
  imageProvider,
  imageSink,
  fileProvider,
  fileSink,
  browserProvider,
  browserSink,
  defaultContentPlugins,
} from "../../src/content/index.js";
import { EntityType, TransferAction, type TransferableEntity } from "../../src/types/transfer.js";

const logger = createLogger("test", "silent");
const grab = { handId: "right", handedness: "right" as const, position: { x: 0.5, y: 0.5 }, timestamp: 0 };

function entity(type: EntityType, payload: unknown, over: Partial<TransferableEntity> = {}): TransferableEntity {
  return {
    id: "e",
    type,
    owner: "A",
    state: "RECEIVED" as TransferableEntity["state"],
    metadata: {},
    payload,
    permissions: { transferable: true, persistable: true },
    createdAt: 0,
    ...over,
  };
}

describe("clipboard provider/sink", () => {
  it("captures the current clipboard into a ClipboardEntity", async () => {
    const cb = new InMemoryClipboardBackend("copied!");
    const draft = await clipboardProvider(cb).capture(grab);
    expect(draft?.type).toBe(EntityType.Clipboard);
    expect((draft?.payload as { formats: Record<string, string> }).formats["text/plain"]).toBe("copied!");
  });

  it("declines when the clipboard is empty", async () => {
    expect(await clipboardProvider(new InMemoryClipboardBackend()).capture(grab)).toBeUndefined();
  });

  it("writes received formats back to the clipboard", async () => {
    const dest = new InMemoryClipboardBackend();
    await clipboardSink(dest).drop(
      entity(EntityType.Clipboard, { formats: { "text/plain": "pasted" } }),
      TransferAction.Copy,
    );
    expect(await dest.readText()).toBe("pasted");
  });
});

describe("text provider/sink", () => {
  it("provides text from a source and writes it to a clipboard", async () => {
    const draft = await textProvider(() => "selection").capture(grab);
    expect(draft?.type).toBe(EntityType.Text);
    const dest = new InMemoryClipboardBackend();
    await clipboardTextSink(dest).drop(entity(EntityType.Text, "selection"), TransferAction.Copy);
    expect(await dest.readText()).toBe("selection");
  });
});

describe("image provider/sink", () => {
  it("round-trips an image through base64", async () => {
    const draft = await imageProvider(() => ({ data: Buffer.from([9, 8, 7]), mimeType: "image/png" })).capture(grab);
    const b64 = (draft?.payload as { dataBase64: string }).dataBase64;
    const dest = new InMemoryClipboardBackend();
    await imageSink(dest).drop(
      entity(EntityType.Image, { dataBase64: b64 }, { metadata: { mimeType: "image/png" } }),
      TransferAction.Copy,
    );
    expect((await dest.readImage())?.data).toEqual(Buffer.from([9, 8, 7]));
  });
});

describe("file provider/sink", () => {
  it("reads a file and writes it into the destination dir", async () => {
    const src = new InMemoryFileBackend({ "/home/me/report.pdf": "PDF-BYTES" });
    const draft = await fileProvider(src, () => "/home/me/report.pdf").capture(grab);
    expect(draft?.metadata.name).toBe("report.pdf");

    const dest = new InMemoryFileBackend();
    await fileSink(dest, "/downloads").drop(
      entity(EntityType.File, (draft as { payload: unknown }).payload, { metadata: { name: "report.pdf" } }),
      TransferAction.Copy,
    );
    expect(dest.peek("/downloads/report.pdf")?.toString()).toBe("PDF-BYTES");
  });
});

describe("browser provider/sink", () => {
  it("opens the received url", async () => {
    const draft = await browserProvider(() => "https://example.com").capture(grab);
    expect(draft?.type).toBe(EntityType.BrowserTab);
    const opener = new RecordingUrlOpener();
    await browserSink(opener).drop(
      entity(EntityType.BrowserTab, { url: "https://example.com" }),
      TransferAction.Open,
    );
    expect(opener.opened).toEqual(["https://example.com"]);
  });
});

describe("priority ordering", () => {
  it("clipboard (100) wins over text (90) for the same grab", async () => {
    const registry = new PluginRegistry(logger);
    registry.registerProvider(textProvider(() => "text-source"));
    registry.registerProvider(clipboardProvider(new InMemoryClipboardBackend("clip")));
    const draft = await registry.resolveProvider(grab);
    expect(draft?.type).toBe(EntityType.Clipboard);
  });
});

describe("defaultContentPlugins", () => {
  it("assembles clipboard + image + browser plugins with an injected backend", async () => {
    const { providers, sinks } = await defaultContentPlugins({
      clipboard: new InMemoryClipboardBackend("x"),
      logger,
    });
    expect(providers.map((p) => p.name)).toContain("clipboard");
    expect(sinks.map((s) => s.name)).toEqual(expect.arrayContaining(["clipboard", "image", "browser"]));
  });
});
