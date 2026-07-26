/**
 * TransferLedger — a bounded record of every transfer, plus analytics.
 *
 * Purpose: the substrate for an AirDrop-style "Recent Transfers" view and for
 * measuring how the system actually performs. It is a *pure EventBus consumer*:
 * it subscribes to `transfer:*` events, correlates them by `transferId`, and
 * keeps a ring buffer of entries. It owns no transfer logic and nothing depends
 * on it — so it adds observability without new coupling.
 *
 * Correlation notes:
 *  - Source (initiator) side has the full lifecycle under one transferId
 *    (started → metrics/retry → completed|failed), including rtt.
 *  - Destination side sees `transfer:received` (no transferId) then
 *    `transfer:completed` (transferId + entityId); we bridge them by entityId so
 *    the received sender is attributed to the completed entry.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { EntityType, TransferAction } from "../types/transfer.js";

export type TransferOutcome = "pending" | "completed" | "failed";

export interface LedgerEntry {
  transferId: string;
  entityId?: string;
  type?: EntityType;
  action?: TransferAction;
  /** Sender device id (populated on the receiving side). */
  source?: string;
  /** Target device id (populated on the sending side). */
  dest?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  rttMs?: number;
  processingMs?: number;
  bytes?: number;
  retryCount: number;
  outcome: TransferOutcome;
  reason?: string;
}

export interface TransferAnalytics {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  successRate: number;
  totalRetries: number;
  totalBytes: number;
  avgDurationMs?: number;
  avgRttMs?: number;
  p50RttMs?: number;
  p95RttMs?: number;
}

export class TransferLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  /** Insertion order of transferIds, for bounded eviction + recency. */
  private readonly order: string[] = [];
  /** Pending `received` metadata awaiting the matching `completed`, by entityId. */
  private readonly pendingReceived = new Map<string, { from: string; type: EntityType }>();
  private readonly unsubscribes: Array<() => void> = [];

  constructor(
    private readonly eventBus: IEventBus,
    private readonly limit = 200,
  ) {}

  attach(): this {
    const bus = this.eventBus;
    this.unsubscribes.push(
      bus.on("transfer:started", (e) => {
        const entry = this.upsert(e.transferId);
        entry.entityId = e.entityId;
        entry.action = e.action;
        entry.dest = e.targetDeviceId;
        entry.startedAt = Date.now();
      }),
      bus.on("transfer:retry", (e) => {
        this.upsert(e.transferId).retryCount = e.attempt;
      }),
      bus.on("transfer:metrics", (e) => {
        const entry = this.upsert(e.transferId);
        entry.rttMs = e.rttMs;
        if (e.processingMs !== undefined) entry.processingMs = e.processingMs;
        if (e.bytes !== undefined) entry.bytes = e.bytes;
        if (e.entityId !== undefined) entry.entityId = e.entityId;
      }),
      bus.on("transfer:received", (e) => {
        this.pendingReceived.set(e.entityId, { from: e.from, type: e.type });
      }),
      bus.on("transfer:completed", (e) => {
        const entry = this.upsert(e.transferId);
        entry.entityId = e.entityId;
        if (e.targetDeviceId !== undefined) entry.dest = e.targetDeviceId;
        const recv = this.pendingReceived.get(e.entityId);
        if (recv) {
          entry.source = recv.from;
          entry.type = recv.type;
          this.pendingReceived.delete(e.entityId);
        }
        entry.outcome = "completed";
        this.finish(entry);
      }),
      bus.on("transfer:failed", (e) => {
        const entry = this.upsert(e.transferId);
        entry.entityId = e.entityId;
        entry.outcome = "failed";
        entry.reason = e.reason;
        this.finish(entry);
      }),
    );
    return this;
  }

  detach(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }

  private upsert(transferId: string): LedgerEntry {
    let entry = this.entries.get(transferId);
    if (!entry) {
      entry = { transferId, retryCount: 0, outcome: "pending" };
      this.entries.set(transferId, entry);
      this.order.push(transferId);
      while (this.order.length > this.limit) {
        const evicted = this.order.shift();
        if (evicted !== undefined) this.entries.delete(evicted);
      }
    }
    return entry;
  }

  private finish(entry: LedgerEntry): void {
    entry.completedAt = Date.now();
    if (entry.startedAt !== undefined) entry.durationMs = entry.completedAt - entry.startedAt;
  }

  /** All entries, oldest first. */
  all(): LedgerEntry[] {
    return this.order.map((id) => this.entries.get(id)!).filter(Boolean);
  }

  /** The `n` most recent entries, newest first. */
  recent(n = 20): LedgerEntry[] {
    return this.all().slice(-n).reverse();
  }

  get(transferId: string): LedgerEntry | undefined {
    return this.entries.get(transferId);
  }

  analytics(): TransferAnalytics {
    const entries = this.all();
    const completed = entries.filter((e) => e.outcome === "completed");
    const failed = entries.filter((e) => e.outcome === "failed");
    const pending = entries.filter((e) => e.outcome === "pending");
    const rtts = entries.map((e) => e.rttMs).filter((v): v is number => typeof v === "number");
    const durations = completed
      .map((e) => e.durationMs)
      .filter((v): v is number => typeof v === "number");
    const settled = completed.length + failed.length;

    return {
      total: entries.length,
      completed: completed.length,
      failed: failed.length,
      pending: pending.length,
      successRate: settled === 0 ? 0 : completed.length / settled,
      totalRetries: entries.reduce((sum, e) => sum + e.retryCount, 0),
      totalBytes: entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      ...(durations.length ? { avgDurationMs: avg(durations) } : {}),
      ...(rtts.length
        ? {
            avgRttMs: avg(rtts),
            p50RttMs: percentile(rtts, 50),
            p95RttMs: percentile(rtts, 95),
          }
        : {}),
    };
  }
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Nearest-rank percentile (p in 0..100). */
function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}
