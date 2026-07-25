/**
 * Typed, in-process event bus.
 *
 * Purpose: the backbone of Air Share's event-driven architecture. Modules emit
 * and subscribe to strongly-typed events (see types/events.ts) instead of
 * calling each other directly, keeping the graph decoupled and testable.
 *
 * Public API: `on`, `once`, `off`, `emit`. Listener exceptions are isolated so
 * one bad subscriber cannot break emission for the others.
 *
 * Dependencies: Logger (for surfacing listener errors). No Node EventEmitter —
 * a thin typed implementation gives us exhaustive event-name/payload checking.
 */

import type {
  AirShareEventListener,
  AirShareEventMap,
  AirShareEventName,
} from "../types/events.js";
import type { Logger } from "../utils/logger.js";

export interface IEventBus {
  on<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): () => void;
  once<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): () => void;
  off<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): void;
  emit<K extends AirShareEventName>(event: K, payload: AirShareEventMap[K]): void;
  removeAll(): void;
}

export class EventBus implements IEventBus {
  private readonly listeners = new Map<
    AirShareEventName,
    Set<AirShareEventListener<AirShareEventName>>
  >();

  constructor(private readonly logger: Logger) {}

  on<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AirShareEventListener<AirShareEventName>);
    return () => this.off(event, listener);
  }

  once<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): () => void {
    const wrapper: AirShareEventListener<K> = (payload) => {
      this.off(event, wrapper);
      listener(payload);
    };
    return this.on(event, wrapper);
  }

  off<K extends AirShareEventName>(event: K, listener: AirShareEventListener<K>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as AirShareEventListener<AirShareEventName>);
    if (set.size === 0) this.listeners.delete(event);
  }

  emit<K extends AirShareEventName>(event: K, payload: AirShareEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot so once()-driven mutations mid-emit don't skip listeners.
    for (const listener of [...set]) {
      try {
        (listener as AirShareEventListener<K>)(payload);
      } catch (error) {
        // Never let one listener's failure abort the others or crash emit.
        this.logger.error("event listener threw", {
          event,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
