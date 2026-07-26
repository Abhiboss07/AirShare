import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { EventBus } from "../../src/events/eventBus.js";
import { createLogger } from "../../src/utils/logger.js";
import {
  TransferLedger,
  ActionExecutor,
  DefaultActionResolver,
  RegistryTargetResolver,
  StaticCipherProvider,
  AesGcmCipher,
  NoopCipher,
} from "../../src/transfer/index.js";
import {
  EntityState,
  EntityType,
  TransferAction,
  type TransferableEntity,
  type VirtualHand,
} from "../../src/types/transfer.js";

const logger = createLogger("test", "silent");

function makeEntity(over: Partial<TransferableEntity> = {}): TransferableEntity {
  return {
    id: "e1",
    type: EntityType.Text,
    owner: "A",
    state: EntityState.Held,
    metadata: { name: "x.txt", sizeBytes: 3 },
    payload: "hey",
    permissions: { transferable: true, persistable: true },
    createdAt: Date.now(),
    ...over,
  };
}

function makeHand(over: Partial<VirtualHand> = {}): VirtualHand {
  return {
    handId: "right",
    handedness: "right",
    holding: true,
    confidence: 1,
    updatedAt: Date.now(),
    ...over,
  };
}

describe("TransferLedger + analytics", () => {
  it("records a full source-side lifecycle correlated by transferId", () => {
    const bus = new EventBus(logger);
    const ledger = new TransferLedger(bus).attach();

    bus.emit("transfer:started", {
      transferId: "t1",
      entityId: "e1",
      action: TransferAction.Copy,
      targetDeviceId: "B",
    });
    bus.emit("transfer:retry", { transferId: "t1", attempt: 1, reason: "boom" });
    bus.emit("transfer:metrics", {
      transferId: "t1",
      entityId: "e1",
      sentAt: 1,
      ackAt: 6,
      rttMs: 5,
      processingMs: 2,
      bytes: 3,
    });
    bus.emit("transfer:completed", { transferId: "t1", entityId: "e1", targetDeviceId: "B" });

    const entry = ledger.get("t1")!;
    expect(entry.outcome).toBe("completed");
    expect(entry.dest).toBe("B");
    expect(entry.retryCount).toBe(1);
    expect(entry.rttMs).toBe(5);
    expect(entry.bytes).toBe(3);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);

    const stats = ledger.analytics();
    expect(stats.total).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.successRate).toBe(1);
    expect(stats.totalRetries).toBe(1);
    expect(stats.totalBytes).toBe(3);
    expect(stats.avgRttMs).toBe(5);
    expect(stats.p95RttMs).toBe(5);
  });

  it("attributes the sender on the destination side via received→completed", () => {
    const bus = new EventBus(logger);
    const ledger = new TransferLedger(bus).attach();
    bus.emit("transfer:received", { entityId: "e9", type: EntityType.Text, from: "A" });
    bus.emit("transfer:completed", { transferId: "t9", entityId: "e9" });
    const entry = ledger.get("t9")!;
    expect(entry.source).toBe("A");
    expect(entry.type).toBe(EntityType.Text);
    expect(entry.outcome).toBe("completed");
  });

  it("tracks failures and computes a mixed success rate", () => {
    const bus = new EventBus(logger);
    const ledger = new TransferLedger(bus).attach();
    bus.emit("transfer:started", { transferId: "ok", entityId: "e1", action: TransferAction.Copy, targetDeviceId: "B" });
    bus.emit("transfer:completed", { transferId: "ok", entityId: "e1", targetDeviceId: "B" });
    bus.emit("transfer:started", { transferId: "bad", entityId: "e2", action: TransferAction.Copy, targetDeviceId: "B" });
    bus.emit("transfer:failed", { transferId: "bad", entityId: "e2", reason: "nope" });
    const stats = ledger.analytics();
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBe(0.5);
    expect(ledger.get("bad")!.reason).toBe("nope");
  });

  it("bounds its ring buffer", () => {
    const bus = new EventBus(logger);
    const ledger = new TransferLedger(bus, 2).attach();
    for (const id of ["a", "b", "c"]) {
      bus.emit("transfer:completed", { transferId: id, entityId: id });
    }
    expect(ledger.all()).toHaveLength(2);
    expect(ledger.get("a")).toBeUndefined();
    expect(ledger.recent(1)[0]!.transferId).toBe("c");
  });
});

describe("action engine", () => {
  it("DefaultActionResolver honours a hand override, else the default", () => {
    const resolver = new DefaultActionResolver(TransferAction.Copy);
    expect(resolver.resolve(makeEntity(), { hand: makeHand() })).toBe(TransferAction.Copy);
    expect(
      resolver.resolve(makeEntity(), { hand: makeHand({ action: TransferAction.Move }) }),
    ).toBe(TransferAction.Move);
  });

  it("ActionExecutor routes a registered action to its handler", async () => {
    const executor = new ActionExecutor();
    const seen: TransferAction[] = [];
    executor.register(TransferAction.Open, (_e, action) => {
      seen.push(action);
    });
    expect(executor.has(TransferAction.Open)).toBe(true);
    expect(executor.has(TransferAction.Copy)).toBe(false);
    await executor.execute(makeEntity(), TransferAction.Open, { transferId: "t", sender: "A" });
    expect(seen).toEqual([TransferAction.Open]);
    await expect(
      executor.execute(makeEntity(), TransferAction.Copy, { transferId: "t", sender: "A" }),
    ).rejects.toThrow();
  });
});

describe("RegistryTargetResolver", () => {
  it("resolves to the sole connected peer", () => {
    const resolver = new RegistryTargetResolver(() => ["B"]);
    expect(resolver.resolve(makeHand(), {})).toBe("B");
  });

  it("applies the capability predicate", () => {
    const resolver = new RegistryTargetResolver(
      () => ["B", "C"],
      (id) => id === "C",
    );
    expect(resolver.resolve(makeHand(), {})).toBe("C");
  });

  it("returns undefined when no candidate qualifies", () => {
    const resolver = new RegistryTargetResolver(() => [], () => true);
    expect(resolver.resolve(makeHand(), {})).toBeUndefined();
  });
});

describe("StaticCipherProvider", () => {
  it("returns the same cipher for every peer and round-trips", async () => {
    const key = randomBytes(32);
    const provider = new StaticCipherProvider(new AesGcmCipher(key));
    const a = provider.cipherFor("B");
    const b = provider.cipherFor("C");
    expect(a).toBe(b);
    const { ciphertext, meta } = await a.encrypt(Buffer.from("obj"));
    expect((await b.decrypt(ciphertext, meta)).toString()).toBe("obj");
  });

  it("defaults to a Noop passthrough cipher", async () => {
    const provider = new StaticCipherProvider();
    const cipher = provider.cipherFor("B");
    expect(cipher).toBeInstanceOf(NoopCipher);
  });
});
