/**
 * Browser provider + sink.
 *
 * Provider: emit a browser-tab entity (a URL, optional title) from a URL source.
 * Sink: open the URL in the destination's default handler via a `UrlOpener`
 * (xdg-open on Linux) — the "pinch a tab, drop it, it opens over there" flow.
 */

import {
  EntityType,
  TransferAction,
  type EntityDraft,
  type TransferableEntity,
} from "../../types/transfer.js";
import type { EntityProvider, EntitySink } from "../../transfer/registry.js";
import type { UrlOpener } from "../backends/types.js";
import { CONTENT_PRIORITY } from "../priorities.js";

export type UrlSource = () => string | undefined | Promise<string | undefined>;

interface BrowserPayload {
  url: string;
  title?: string;
}

export function browserProvider(source: UrlSource, title?: () => string | undefined): EntityProvider {
  return {
    name: "browser",
    types: [EntityType.BrowserTab],
    priority: CONTENT_PRIORITY.browser,
    permissions: { read: true },
    async capture(): Promise<EntityDraft | undefined> {
      const url = await source();
      if (!url) return undefined;
      const t = title?.();
      const payload: BrowserPayload = { url, ...(t ? { title: t } : {}) };
      return {
        type: EntityType.BrowserTab,
        metadata: { name: t ?? url, mimeType: "text/uri-list", sizeBytes: Buffer.byteLength(url) },
        payload,
        preview: { kind: "text", text: t ?? url },
        permissions: { transferable: true, persistable: false },
      };
    },
  };
}

export function browserSink(opener: UrlOpener): EntitySink {
  return {
    name: "browser",
    types: [EntityType.BrowserTab],
    actions: [TransferAction.Open, TransferAction.Copy],
    priority: CONTENT_PRIORITY.browser,
    permissions: { write: true, requiresOsPermission: false },
    async drop(entity: TransferableEntity): Promise<void> {
      const payload = entity.payload as BrowserPayload;
      if (payload.url) await opener.open(payload.url);
    },
  };
}
