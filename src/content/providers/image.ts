/**
 * Image provider + sink.
 *
 * Provider: emit an `ImageEntity` (base64 payload) from an image source — the
 * clipboard image, or an injected buffer source. Sink: write the image to the
 * destination clipboard. PNG/JPEG/BMP/WebP are carried opaquely by MIME type.
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

export interface RawImage {
  data: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
}

export type ImageSource = () => RawImage | undefined | Promise<RawImage | undefined>;

interface ImagePayload {
  dataBase64: string;
  width?: number;
  height?: number;
}

export function imageProvider(source: ImageSource): EntityProvider {
  return {
    name: "image",
    types: [EntityType.Image],
    priority: CONTENT_PRIORITY.image,
    permissions: { read: true, maxBytes: 64 * 1024 * 1024 },
    async capture(): Promise<EntityDraft | undefined> {
      const image = await source();
      if (!image) return undefined;
      const payload: ImagePayload = {
        dataBase64: image.data.toString("base64"),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
      };
      return {
        type: EntityType.Image,
        metadata: { name: "image", mimeType: image.mimeType, sizeBytes: image.data.length },
        payload,
        preview: { kind: "image" },
        permissions: { transferable: true, persistable: true },
      };
    },
  };
}

/** Grab whatever image is currently on the clipboard. */
export function clipboardImageProvider(backend: ClipboardBackend): EntityProvider {
  return imageProvider(async () => {
    const image = await backend.readImage?.();
    return image ? { data: image.data, mimeType: image.mimeType } : undefined;
  });
}

export function imageSink(backend: ClipboardBackend): EntitySink {
  return {
    name: "image",
    types: [EntityType.Image],
    actions: [TransferAction.Copy, TransferAction.Paste],
    priority: CONTENT_PRIORITY.image,
    permissions: { write: true },
    async drop(entity: TransferableEntity): Promise<void> {
      if (!backend.writeImage) throw new Error("clipboard backend cannot write images");
      const payload = entity.payload as ImagePayload;
      const mimeType = entity.metadata.mimeType ?? "image/png";
      await backend.writeImage(Buffer.from(payload.dataBase64, "base64"), mimeType);
    },
  };
}
