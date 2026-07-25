import { describe, it, expect } from "vitest";
import { PluginRegistry } from "../../src/transfer/registry.js";
import { createLogger } from "../../src/utils/logger.js";
import { EntityType, TransferAction, EntityState } from "../../src/types/transfer.js";
import { MockTextProvider, DecliningProvider, RecordingSink } from "./fixtures.js";
import type { TransferableEntity } from "../../src/types/transfer.js";

const logger = createLogger("test", "silent");
const ctx = { handId: "right", handedness: "right" as const, position: { x: 0.5, y: 0.5 }, timestamp: 0 };

describe("PluginRegistry", () => {
  it("registers a plugin's providers and sinks", () => {
    const reg = new PluginRegistry(logger);
    reg.register({ name: "p", providers: [new MockTextProvider()], sinks: [new RecordingSink()] });
    expect(reg.providerCount).toBe(1);
    expect(reg.sinkCount).toBe(1);
  });

  it("resolves the first provider that produces an entity", async () => {
    const reg = new PluginRegistry(logger);
    reg.registerProvider(new DecliningProvider());
    reg.registerProvider(new MockTextProvider("grabbed"));
    const draft = await reg.resolveProvider(ctx);
    expect(draft?.type).toBe(EntityType.Text);
    expect(draft?.payload).toBe("grabbed");
  });

  it("honors provider priority", async () => {
    const reg = new PluginRegistry(logger);
    const low = new MockTextProvider("low");
    const high = Object.assign(new MockTextProvider("high"), { priority: 10 });
    reg.registerProvider(low);
    reg.registerProvider(high);
    expect((await reg.resolveProvider(ctx))?.payload).toBe("high");
  });

  it("matches a sink by type × action, and returns undefined otherwise", () => {
    const reg = new PluginRegistry(logger);
    reg.registerSink(new RecordingSink());
    const entity = { type: EntityType.Text, state: EntityState.Ready } as TransferableEntity;
    expect(reg.resolveSink(entity, TransferAction.Copy)?.name).toBe("recording");
    expect(reg.resolveSink(entity, TransferAction.Cast)).toBeUndefined();
    const image = { type: EntityType.VideoStream } as TransferableEntity;
    expect(reg.resolveSink(image, TransferAction.Copy)).toBeUndefined();
  });
});
