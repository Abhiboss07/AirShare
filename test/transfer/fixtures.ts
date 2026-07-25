import {
  EntityType,
  TransferAction,
  type EntityDraft,
  type TransferableEntity,
} from "../../src/types/transfer.js";
import type { EntityProvider, EntitySink } from "../../src/transfer/registry.js";

/** A provider that "grabs" a fixed piece of text as an entity. */
export class MockTextProvider implements EntityProvider {
  readonly name = "mock-text";
  readonly types = [EntityType.Text];
  constructor(private readonly text = "hello from the clipboard") {}
  capture(): EntityDraft {
    return {
      type: EntityType.Text,
      metadata: { name: "clip.txt", mimeType: "text/plain", sizeBytes: this.text.length },
      payload: this.text,
      preview: { kind: "text", text: this.text.slice(0, 32) },
      permissions: { transferable: true, persistable: true },
    };
  }
}

/** A provider that declines everything (to test provider fallthrough). */
export class DecliningProvider implements EntityProvider {
  readonly name = "declining";
  readonly types = [EntityType.Custom];
  capture(): undefined {
    return undefined;
  }
}

/** A sink that records what it received. */
export class RecordingSink implements EntitySink {
  readonly name = "recording";
  readonly types = [EntityType.Text, EntityType.Clipboard, EntityType.File, EntityType.Image];
  readonly actions = [TransferAction.Copy, TransferAction.Paste, TransferAction.Open];
  readonly received: { entity: TransferableEntity; action: TransferAction }[] = [];
  async drop(entity: TransferableEntity, action: TransferAction): Promise<void> {
    this.received.push({ entity, action });
  }
}
