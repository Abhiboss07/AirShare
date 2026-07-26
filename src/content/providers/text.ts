/**
 * Text provider + sink.
 *
 * Provider: emit a `TextEntity` from a text source (a selection callback, or the
 * clipboard's text). Sink: write received text via a handler (default: the
 * clipboard backend). The thinnest possible content plugin.
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

export type TextSource = () => string | undefined | Promise<string | undefined>;

export function textProvider(source: TextSource): EntityProvider {
  return {
    name: "text",
    types: [EntityType.Text],
    priority: CONTENT_PRIORITY.text,
    permissions: { read: true },
    async capture(): Promise<EntityDraft | undefined> {
      const text = await source();
      if (!text) return undefined;
      return {
        type: EntityType.Text,
        metadata: { name: "text.txt", mimeType: "text/plain", sizeBytes: Buffer.byteLength(text) },
        payload: text,
        preview: { kind: "text", text: text.slice(0, 64) },
        permissions: { transferable: true, persistable: true },
      };
    },
  };
}

/** Writes received text somewhere; defaults to the clipboard. */
export function textSink(write: (text: string) => Promise<void> | void): EntitySink {
  return {
    name: "text",
    types: [EntityType.Text],
    actions: [TransferAction.Copy, TransferAction.Paste],
    priority: CONTENT_PRIORITY.text,
    permissions: { write: true },
    async drop(entity: TransferableEntity): Promise<void> {
      await write(String(entity.payload ?? ""));
    },
  };
}

/** Convenience: a text sink backed by a clipboard. */
export function clipboardTextSink(backend: ClipboardBackend): EntitySink {
  return textSink((text) => backend.writeText(text));
}
