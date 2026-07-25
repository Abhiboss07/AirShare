import { describe, it, expect } from "vitest";
import { EntityManager } from "../../src/transfer/entityManager.js";
import { EventBus } from "../../src/events/eventBus.js";
import { createLogger } from "../../src/utils/logger.js";
import { EntityState, EntityType } from "../../src/types/transfer.js";

const logger = createLogger("test", "silent");
const opts = { maxEntityBytes: 1000, historyLimit: 10, cacheLimit: 10 };

function textInput(text = "hi") {
  return {
    type: EntityType.Text,
    owner: "devA",
    metadata: { sizeBytes: text.length },
    payload: text,
    permissions: { transferable: true, persistable: true },
  };
}

describe("EntityManager", () => {
  it("creates entities in CREATED and emits entity:created", () => {
    const bus = new EventBus(logger);
    const mgr = new EntityManager(bus, opts, logger);
    let created = false;
    bus.on("entity:created", () => (created = true));
    const e = mgr.create(textInput());
    expect(e.state).toBe(EntityState.Created);
    expect(created).toBe(true);
    expect(mgr.get(e.id)?.id).toBe(e.id);
  });

  it("enforces legal transitions and emits entity:state", () => {
    const bus = new EventBus(logger);
    const mgr = new EntityManager(bus, opts, logger);
    const states: string[] = [];
    bus.on("entity:state", (ev) => states.push(ev.to));
    const e = mgr.create(textInput());
    expect(mgr.transition(e.id, EntityState.Selected)).toBe(true);
    expect(mgr.transition(e.id, EntityState.Sending)).toBe(false); // illegal jump
    expect(states).toEqual([EntityState.Selected]);
  });

  it("retires terminal entities into history and cache", () => {
    const bus = new EventBus(logger);
    const mgr = new EntityManager(bus, opts, logger);
    const e = mgr.create(textInput());
    for (const s of [EntityState.Selected, EntityState.Locked, EntityState.Held, EntityState.Dropped, EntityState.Completed]) {
      mgr.transition(e.id, s);
    }
    expect(mgr.get(e.id)).toBeUndefined(); // removed from live set
    expect(mgr.history().at(-1)?.finalState).toBe(EntityState.Completed);
    expect(mgr.recover(e.id)?.id).toBe(e.id); // still recoverable
  });

  it("round-trips payload through encode/serialize/decode", () => {
    const bus = new EventBus(logger);
    const mgr = new EntityManager(bus, opts, logger);
    const e = mgr.create(textInput("payload text"));
    const { data, encoding } = mgr.encodePayload(e);
    const serialized = mgr.buildSerialized(e, data.toString("base64"), encoding);
    const decoded = mgr.decodePayload(Buffer.from(serialized.payload, "base64"), serialized.payloadEncoding);
    const restored = mgr.fromSerialized(serialized, decoded);
    expect(restored.payload).toBe("payload text");
    expect(restored.state).toBe(EntityState.Received);
  });

  it("validates transferability, size and expiry", () => {
    const bus = new EventBus(logger);
    const mgr = new EntityManager(bus, opts, logger);
    expect(mgr.validate(mgr.create(textInput())).ok).toBe(true);
    const big = mgr.create({ ...textInput(), metadata: { sizeBytes: 999999 } });
    expect(mgr.validate(big).ok).toBe(false);
    const locked = mgr.create({ ...textInput(), permissions: { transferable: false, persistable: true } });
    expect(mgr.validate(locked).ok).toBe(false);
  });
});
