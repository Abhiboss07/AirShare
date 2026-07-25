import { describe, it, expect, vi } from "vitest";
import { TransferScheduler, DEFAULT_SCHEDULER_CONFIG } from "../../src/transfer/scheduler.js";
import { BaseTransferTransport, NotImplementedError } from "../../src/transfer/transport.js";
import { createLogger } from "../../src/utils/logger.js";
import { EntityType, TransferAction, type TransferAck, type TransferEnvelope } from "../../src/types/transfer.js";

const logger = createLogger("test", "silent");

function envelope(id: string, priority?: number): TransferEnvelope {
  return {
    transferId: id,
    action: TransferAction.Copy,
    sender: "A",
    target: "B",
    entity: {
      id: `e-${id}`,
      type: EntityType.Text,
      owner: "A",
      metadata: priority !== undefined ? { priority } : {},
      permissions: { transferable: true, persistable: true },
      createdAt: 0,
      payload: "x",
      payloadEncoding: "json",
    },
  };
}

/** Inner transport whose send resolution is controllable. */
class ControllableTransport extends BaseTransferTransport {
  readonly order: string[] = [];
  private resolvers = new Map<string, (ack: TransferAck) => void>();
  concurrentPeak = 0;
  private current = 0;

  onReceive(): void {}
  send(env: TransferEnvelope): Promise<TransferAck> {
    this.order.push(env.transferId);
    this.current++;
    this.concurrentPeak = Math.max(this.concurrentPeak, this.current);
    return new Promise((resolve) => {
      this.resolvers.set(env.transferId, (ack) => {
        this.current--;
        resolve(ack);
      });
    });
  }
  complete(id: string, accepted = true): void {
    this.resolvers.get(id)?.({ transferId: id, accepted });
    this.resolvers.delete(id);
  }
  inFlightNow(): number {
    return this.current;
  }
}

describe("TransferScheduler", () => {
  const tick = () => new Promise((r) => setImmediate(r));

  it("limits concurrency to maxConcurrent", async () => {
    const inner = new ControllableTransport();
    const sched = new TransferScheduler(inner, { ...DEFAULT_SCHEDULER_CONFIG, maxConcurrent: 2 }, logger);
    const acks = [sched.send(envelope("1")), sched.send(envelope("2")), sched.send(envelope("3"))];
    await tick();
    expect(inner.inFlightNow()).toBe(2);
    expect(sched.inFlight).toBe(2);
    expect(sched.queued).toBe(1);
    inner.complete("1");
    await tick(); // job 3 now starts
    inner.complete("2");
    inner.complete("3");
    await Promise.all(acks);
    expect(inner.concurrentPeak).toBe(2);
  });

  it("dispatches higher-priority transfers first", async () => {
    const inner = new ControllableTransport();
    const sched = new TransferScheduler(inner, { ...DEFAULT_SCHEDULER_CONFIG, maxConcurrent: 1 }, logger);
    const a = sched.send(envelope("low", 0));
    const b = sched.send(envelope("high", 10));
    const c = sched.send(envelope("mid", 5));
    await tick();
    // "low" already started (queue was empty); then high before mid by priority.
    inner.complete("low");
    await tick();
    inner.complete("high");
    await tick();
    inner.complete("mid");
    await Promise.all([a, b, c]);
    expect(inner.order).toEqual(["low", "high", "mid"]);
  });

  it("cancels a queued transfer", async () => {
    const inner = new ControllableTransport();
    const sched = new TransferScheduler(inner, { ...DEFAULT_SCHEDULER_CONFIG, maxConcurrent: 1 }, logger);
    sched.send(envelope("first"));
    const second = sched.send(envelope("second"));
    await Promise.resolve();
    await sched.cancel("second");
    const ack = await second;
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toBe("cancelled");
  });

  it("retries on a thrown error then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const flaky = new (class extends BaseTransferTransport {
      onReceive(): void {}
      async send(env: TransferEnvelope): Promise<TransferAck> {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { transferId: env.transferId, accepted: true };
      }
    })();
    const sched = new TransferScheduler(flaky, { ...DEFAULT_SCHEDULER_CONFIG, maxRetries: 2 }, logger);
    const p = sched.send(envelope("r"));
    await vi.advanceTimersByTimeAsync(1000);
    const ack = await p;
    expect(ack.accepted).toBe(true);
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("forwards streaming methods to the inner transport (NotImplemented by default)", async () => {
    const inner = new ControllableTransport();
    const sched = new TransferScheduler(inner, DEFAULT_SCHEDULER_CONFIG, logger);
    await expect(sched.pause("x")).rejects.toBeInstanceOf(NotImplementedError);
  });
});
