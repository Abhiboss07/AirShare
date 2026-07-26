/**
 * File provider + sink (single file this phase).
 *
 * Provider: read a file from a path source into a `FileEntity` (base64 payload +
 * name/size metadata). Sink: write the received bytes into a destination
 * directory. Multi-file/folder and chunked streaming are deferred — the
 * scheduler's `sendStream` is still `NotImplemented`.
 */

import path from "node:path";
import {
  EntityType,
  TransferAction,
  type EntityDraft,
  type TransferableEntity,
} from "../../types/transfer.js";
import type { EntityProvider, EntitySink } from "../../transfer/registry.js";
import type { FileBackend } from "../backends/types.js";
import { CONTENT_PRIORITY } from "../priorities.js";

export type PathSource = () => string | undefined | Promise<string | undefined>;

interface FilePayload {
  path?: string;
  dataBase64?: string;
}

export function fileProvider(backend: FileBackend, source: PathSource): EntityProvider {
  return {
    name: "file",
    types: [EntityType.File],
    priority: CONTENT_PRIORITY.file,
    permissions: { read: true, streaming: false, maxBytes: 256 * 1024 * 1024 },
    async capture(): Promise<EntityDraft | undefined> {
      const filePath = await source();
      if (!filePath) return undefined;
      const stat = await backend.stat(filePath);
      const data = await backend.readFile(filePath);
      const payload: FilePayload = { path: filePath, dataBase64: data.toString("base64") };
      return {
        type: EntityType.File,
        metadata: { name: stat.name, sizeBytes: stat.sizeBytes },
        payload,
        preview: { kind: "icon", text: stat.name },
        permissions: { transferable: true, persistable: true },
      };
    },
  };
}

/** Writes received files into `destDir` under their original name. */
export function fileSink(backend: FileBackend, destDir: string): EntitySink {
  return {
    name: "file",
    types: [EntityType.File],
    actions: [TransferAction.Copy, TransferAction.Move],
    priority: CONTENT_PRIORITY.file,
    permissions: { write: true },
    async drop(entity: TransferableEntity): Promise<void> {
      const payload = entity.payload as FilePayload;
      if (!payload.dataBase64) throw new Error("file entity has no inline data");
      const name = entity.metadata.name ?? "received.bin";
      await backend.writeFile(path.join(destDir, name), Buffer.from(payload.dataBase64, "base64"));
    },
  };
}
