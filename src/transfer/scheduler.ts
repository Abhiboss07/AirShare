/**
 * TransferScheduler — the queue between the runtime and the wire.
 *
 * Purpose: the runtime shouldn't fire raw sends at the network. The scheduler
 * sits transparently in front of any `ITransferTransport` (it *is* one, via the
 * decorator pattern) and adds priority ordering, bounded concurrency (congestion
 * control), automatic retries with backoff, and cancellation. The TransferRuntime
 * is unchanged — it just receives a smarter transport.
 *
 *   TransferRuntime → TransferScheduler → (inner transport) → network
 *
 * Streaming/pause/resume are forwarded to the inner transport; larger features
 * (chunk ordering, resume, bandwidth caps) have a natural home here later.
 */

import type { TransferAck, TransferEnvelope } from "../types/transfer.js";
import { BaseTransferTransport, type ITransferTransport, type ReceiveHandler, type StreamMeta } from "./transport.js";
import { computeBackoff, type BackoffOptions } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

export interface SchedulerConfig {
  /** Max simultaneous in-flight transfers (congestion control). */
  maxConcurrent: number;
  /** Retries after a failure/rejected ack before giving up. */
  maxRetries: number;
  backoff: BackoffOptions;
  /** Also retry when a peer returns an ack with accepted=false. */
  retryOnRejectedAck: boolean;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrent: 4,
  maxRetries: 2,
  backoff: { baseDelayMs: 250, maxDelayMs: 5_000, factor: 2, jitter: 0.2 },
  retryOnRejectedAck: false,
};

interface Job {
  envelope: TransferEnvelope;
  priority: number;
  attempts: number;
  cancelled: boolean;
  settled: boolean;
  resolve: (ack: TransferAck) => void;
  timer?: NodeJS.Timeout;
}

export class TransferScheduler extends BaseTransferTransport {
  private readonly queue: Job[] = [];
  private readonly jobs = new Map<string, Job>();
  private active = 0;

  constructor(
    private readonly inner: ITransferTransport,
    private readonly config: SchedulerConfig,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Diagnostics: number of queued (not yet in-flight) jobs. */
  get queued(): number {
    return this.queue.length;
  }
  get inFlight(): number {
    return this.active;
  }

  override onReceive(handler: ReceiveHandler): void {
    this.inner.onReceive(handler);
  }

  override send(envelope: TransferEnvelope): Promise<TransferAck> {
    return new Promise<TransferAck>((resolve) => {
      const job: Job = {
        envelope,
        priority: this.priorityOf(envelope),
        attempts: 0,
        cancelled: false,
        settled: false,
        resolve,
      };
      this.jobs.set(envelope.transferId, job);
      this.enqueue(job);
      this.pump();
    });
  }

  override async cancel(transferId: string): Promise<void> {
    const job = this.jobs.get(transferId);
    if (!job) return;
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    // If still queued, remove and settle now; if in-flight, it settles on return.
    const idx = this.queue.indexOf(job);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.settle(job, { transferId, accepted: false, reason: "cancelled" });
    }
  }

  /** Forward streaming to the inner transport (it decides support). */
  override sendStream(meta: StreamMeta, chunks: AsyncIterable<Uint8Array>): Promise<TransferAck> {
    return this.inner.sendStream(meta, chunks);
  }
  override pause(transferId: string): Promise<void> {
    return this.inner.pause(transferId);
  }
  override resume(transferId: string): Promise<void> {
    return this.inner.resume(transferId);
  }

  private priorityOf(envelope: TransferEnvelope): number {
    const p = envelope.entity.metadata.priority;
    return typeof p === "number" ? p : 0;
  }

  /** Insert keeping the queue sorted by descending priority (stable-ish). */
  private enqueue(job: Job): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.priority < job.priority) i--;
    this.queue.splice(i, 0, job);
  }

  private pump(): void {
    while (this.active < this.config.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.cancelled) continue;
      this.active++;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const ack = await this.inner.send(job.envelope);
      if (job.cancelled) {
        this.settle(job, { transferId: job.envelope.transferId, accepted: false, reason: "cancelled" });
        return;
      }
      const shouldRetry = !ack.accepted && this.config.retryOnRejectedAck;
      if (shouldRetry && job.attempts < this.config.maxRetries) {
        this.scheduleRetry(job);
        return;
      }
      this.settle(job, ack);
    } catch (error) {
      if (!job.cancelled && job.attempts < this.config.maxRetries) {
        this.scheduleRetry(job);
        return;
      }
      this.settle(job, {
        transferId: job.envelope.transferId,
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.active--;
      this.pump();
    }
  }

  private scheduleRetry(job: Job): void {
    const delay = computeBackoff(job.attempts, this.config.backoff);
    job.attempts++;
    this.logger.debug("retrying transfer", { transferId: job.envelope.transferId, attempt: job.attempts, delay });
    job.timer = setTimeout(() => {
      if (job.cancelled) return;
      this.enqueue(job);
      this.pump();
    }, delay);
    job.timer.unref?.();
  }

  private settle(job: Job, ack: TransferAck): void {
    if (job.settled) return;
    job.settled = true;
    this.jobs.delete(job.envelope.transferId);
    job.resolve(ack);
  }
}
