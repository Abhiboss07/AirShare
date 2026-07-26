/**
 * Clipboard provider + sink — the ⭐ vertical slice.
 *
 * Provider: on a grab, snapshot the current clipboard into a `ClipboardEntity`
 * carrying every available format (text/plain, text/html, image/*). Sink: write
 * the received formats back to the destination clipboard, so the user can paste.
 * Both delegate all OS contact to an injected `ClipboardBackend`.
 */

import {
  EntityType,
  TransferAction,
  type EntityDraft,
  type TransferableEntity,
} from "../../types/transfer.js";
import type { EntityProvider, EntitySink } from "../../transfer/registry.js";
import type { ClipboardBackend } from "../backends/types.js";
import { CONTENT_PRIORITY } from "../priorities.js";

interface ClipboardPayload {
  formats: Record<string, string>;
}

function byteLength(formats: Record<string, string>): number {
  return Object.values(formats).reduce((n, v) => n + Buffer.byteLength(v), 0);
}

export function clipboardProvider(backend: ClipboardBackend): EntityProvider {
  return {
    name: "clipboard",
    types: [EntityType.Clipboard],
    priority: CONTENT_PRIORITY.clipboard,
    permissions: { read: true },
    async capture(): Promise<EntityDraft | undefined> {
      const formats: Record<string, string> = {};
      const text = await backend.readText().catch(() => "");
      if (text) formats["text/plain"] = text;
      if (backend.readHtml) {
        const html = await backend.readHtml().catch(() => undefined);
        if (html) formats["text/html"] = html;
      }
      if (backend.readImage) {
        const image = await backend.readImage().catch(() => undefined);
        if (image) formats[image.mimeType] = image.data.toString("base64");
      }
      if (Object.keys(formats).length === 0) return undefined; // empty clipboard

      const preview = (formats["text/plain"] ?? "").slice(0, 64);
      return {
        type: EntityType.Clipboard,
        metadata: { name: "clipboard", sizeBytes: byteLength(formats) },
        payload: { formats } satisfies ClipboardPayload,
        preview: { kind: "text", text: preview },
        permissions: { transferable: true, persistable: true },
      };
    },
  };
}

export function clipboardSink(backend: ClipboardBackend): EntitySink {
  return {
    name: "clipboard",
    types: [EntityType.Clipboard, EntityType.Text],
    actions: [TransferAction.Copy, TransferAction.Paste],
    priority: CONTENT_PRIORITY.clipboard,
    permissions: { write: true },
    async drop(entity: TransferableEntity): Promise<void> {
      // A plain text entity maps straight onto the clipboard's text.
      if (entity.type === EntityType.Text && typeof entity.payload === "string") {
        await backend.writeText(entity.payload);
        return;
      }
      const formats = (entity.payload as ClipboardPayload).formats ?? {};
      if (formats["text/plain"]) await backend.writeText(formats["text/plain"]);
      if (formats["text/html"] && backend.writeHtml) await backend.writeHtml(formats["text/html"]);
      const imageMime = Object.keys(formats).find((m) => m.startsWith("image/"));
      if (imageMime && backend.writeImage) {
        await backend.writeImage(Buffer.from(formats[imageMime]!, "base64"), imageMime);
      }
    },
  };
}
