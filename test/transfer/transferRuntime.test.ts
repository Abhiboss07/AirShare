import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/events/eventBus.js";
import { createLogger } from "../../src/utils/logger.js";
import {
  composeTransferRuntime,
  InMemoryTransferSwitch,
  InMemoryTransferTransport,
  AesGcmCipher,
  StaticTargetResolver,
} from "../../src/transfer/index.js";
import type { AirShareEventMap, AirShareEventName } from "../../src/types/events.js";
import { EntityState } from "../../src/types/transfer.js";
import { MockTextProvider, RecordingSink } from "./fixtures.js";

const logger = createLogger("test", "silent");
const flush = () => new Promise((r) => setImmediate(r));

function waitForBus<K extends AirShareEventName>(
  bus: EventBus,
  event: K,
  timeoutMs = 3000,
): Promise<AirShareEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    const off = bus.on(event, (p) => {
      clearTimeout(timer);
      off();
      resolve(p);
    });
  });
}

interface Node {
  bus: EventBus;
  composed: ReturnType<typeof composeTransferRuntime>;
}

function makeNode(
  deviceId: string,
  sw: InMemoryTransferSwitch,
  opts: { cipher: AesGcmCipher; target?: string | undefined; provider?: MockTextProvider; sink?: RecordingSink },
): Node {
  const bus = new EventBus(logger);
  const composed = composeTransferRuntime({
    localDeviceId: deviceId,
    eventBus: bus,
    transport: new InMemoryTransferTransport(deviceId, sw),
    logger,
    cipher: opts.cipher,
    targetResolver: new StaticTargetResolver(opts.target),
  });
  if (opts.provider) composed.registry.registerProvider(opts.provider);
  if (opts.sink) composed.registry.registerSink(opts.sink);
  composed.runtime.attach();
  return { bus, composed };
}

async function driveGrabAndRelease(bus: EventBus): Promise<void> {
  bus.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
  bus.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.95 });
  await flush(); // let the async grab resolve the provider
  bus.emit("gesture:point", {
    handId: "right",
    position: { x: 0.4, y: 0.5 },
    direction: { x: 0, y: -1 },
    confidence: 0.9,
  });
  bus.emit("gesture:pinch-release", { handId: "right", position: { x: 0.8, y: 0.5 }, heldMs: 500 });
}

describe("TransferRuntime end-to-end (loopback)", () => {
  it("transfers a grabbed entity from A to B and drops it via a sink", async () => {
    const sw = new InMemoryTransferSwitch();
    const key = randomBytes(32);
    const sink = new RecordingSink();
    const source = makeNode("A", sw, {
      cipher: new AesGcmCipher(key),
      target: "B",
      provider: new MockTextProvider("beam me over"),
    });
    makeNode("B", sw, { cipher: new AesGcmCipher(key), sink });

    const completedOnA = waitForBus(source.bus, "transfer:completed");
    await driveGrabAndRelease(source.bus);
    const done = await completedOnA;

    expect(done.targetDeviceId).toBe("B");
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.entity.payload).toBe("beam me over");
    expect(sink.received[0]!.entity.owner).toBe("A");

    // Source hand is empty again.
    const hand = source.composed.hands.get("right");
    expect(hand?.holding).toBe(false);
    expect(hand?.entityId).toBeUndefined();

    // Both sides recorded a completed transfer in history.
    expect(source.composed.entities.history().at(-1)?.finalState).toBe(EntityState.Completed);
  });

  it("emits hand:grab and target-changed during the interaction", async () => {
    const sw = new InMemoryTransferSwitch();
    const key = randomBytes(32);
    const source = makeNode("A", sw, {
      cipher: new AesGcmCipher(key),
      target: "B",
      provider: new MockTextProvider(),
    });
    makeNode("B", sw, { cipher: new AesGcmCipher(key), sink: new RecordingSink() });

    const grab = waitForBus(source.bus, "hand:grab");
    const target = waitForBus(source.bus, "hand:target-changed");
    await driveGrabAndRelease(source.bus);
    expect((await grab).entityId).toBeTruthy();
    expect((await target).targetDeviceId).toBe("B");
  });

  it("drops in place (no transfer) when there is no target", async () => {
    const sw = new InMemoryTransferSwitch();
    const key = randomBytes(32);
    const sink = new RecordingSink();
    const source = makeNode("A", sw, {
      cipher: new AesGcmCipher(key),
      target: undefined, // resolver yields no target
      provider: new MockTextProvider(),
    });
    makeNode("B", sw, { cipher: new AesGcmCipher(key), sink });

    const released = waitForBus(source.bus, "hand:release");
    // Skip the point gesture so no target is set at all.
    source.bus.emit("gesture:hand-detected", { handId: "right", handedness: "right" });
    source.bus.emit("gesture:pinch-start", { handId: "right", position: { x: 0.4, y: 0.5 }, confidence: 0.9 });
    await flush();
    source.bus.emit("gesture:pinch-release", { handId: "right", position: { x: 0.4, y: 0.5 }, heldMs: 200 });
    await released;
    await flush();

    expect(sink.received).toHaveLength(0); // nothing sent
    expect(source.composed.entities.history().at(-1)?.finalState).toBe(EntityState.Completed);
  });

  it("fails the transfer when the destination has no matching sink", async () => {
    const sw = new InMemoryTransferSwitch();
    const key = randomBytes(32);
    const source = makeNode("A", sw, {
      cipher: new AesGcmCipher(key),
      target: "B",
      provider: new MockTextProvider(),
    });
    makeNode("B", sw, { cipher: new AesGcmCipher(key) }); // no sink registered

    const failed = waitForBus(source.bus, "transfer:failed");
    await driveGrabAndRelease(source.bus);
    expect((await failed).reason).toMatch(/no sink/);
  });
});
