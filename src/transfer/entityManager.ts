/**
 * EntityManager — the single gateway for entity lifecycle & persistence.
 *
 * Purpose: everything that happens to an entity goes through here: creation,
 * legal state transitions (delegated to EntityStateMachine), (de)serialization
 * for the wire, payload encoding, an at-rest cache for recovery, a bounded
 * transfer history, and validation. Gestures and providers never mutate entity
 * state directly — they ask the manager, which keeps the model consistent and
 * emits `entity:*` events.
 *
 * Dependencies: EventBus, EntityStateMachine, Logger, utils/ids. No networking.
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import { newMessageId } from "../utils/ids.js";
import {
  EntityState,
  type EntityType,
  type PayloadEncoding,
  type SerializedEntity,
  type TransferableEntity,
} from "../types/transfer.js";
import { EntityStateMachine, isTerminal } from "./entityStateMachine.js";

export interface EntityManagerOptions {
  maxEntityBytes: number;
  historyLimit: number;
  cacheLimit: number;
}

export interface TransferHistoryEntry {
  entityId: string;
  type: EntityType;
  finalState: EntityState;
  owner: string;
  at: number;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Fields a caller supplies to create an entity; the rest are filled in. */
export type EntityInput = Omit<TransferableEntity, "id" | "state" | "createdAt"> &
  Partial<Pick<TransferableEntity, "id" | "createdAt">>;

interface ManagedEntity {
  entity: TransferableEntity;
  machine: EntityStateMachine;
}

export class EntityManager {
  private readonly entities = new Map<string, ManagedEntity>();
  private readonly cacheStore = new Map<string, TransferableEntity>();
  private readonly historyLog: TransferHistoryEntry[] = [];

  constructor(
    private readonly eventBus: IEventBus,
    private readonly options: EntityManagerOptions,
    private readonly logger: Logger,
  ) {}

  /** Create and register a new entity in the CREATED state. */
  create(input: EntityInput): TransferableEntity {
    const entity: TransferableEntity = {
      ...input,
      id: input.id ?? newMessageId(),
      state: EntityState.Created,
      createdAt: input.createdAt ?? Date.now(),
    };
    this.entities.set(entity.id, {
      entity,
      machine: new EntityStateMachine(EntityState.Created),
    });
    this.logger.debug("entity created", { id: entity.id, type: entity.type });
    this.eventBus.emit("entity:created", { entity });
    return entity;
  }

  /** Register an entity that arrived from the wire, in the RECEIVED state. */
  adopt(entity: TransferableEntity): TransferableEntity {
    const received: TransferableEntity = { ...entity, state: EntityState.Received };
    this.entities.set(received.id, {
      entity: received,
      machine: new EntityStateMachine(EntityState.Received),
    });
    return received;
  }

  get(id: string): TransferableEntity | undefined {
    return this.entities.get(id)?.entity;
  }
  list(): TransferableEntity[] {
    return [...this.entities.values()].map((m) => m.entity);
  }
  has(id: string): boolean {
    return this.entities.has(id);
  }

  /** Advance an entity's state. Returns false on an illegal transition. */
  transition(id: string, to: EntityState): boolean {
    const managed = this.entities.get(id);
    if (!managed) return false;
    const from = managed.machine.current;
    if (!managed.machine.tryTransition(to)) {
      this.logger.warn("rejected illegal transition", { id, from, to });
      return false;
    }
    managed.entity.state = to;
    this.eventBus.emit("entity:state", { entityId: id, type: managed.entity.type, from, to });
    if (isTerminal(to)) this.retire(managed.entity);
    return true;
  }

  private retire(entity: TransferableEntity): void {
    this.historyLog.push({
      entityId: entity.id,
      type: entity.type,
      finalState: entity.state,
      owner: entity.owner,
      at: Date.now(),
    });
    while (this.historyLog.length > this.options.historyLimit) this.historyLog.shift();
    // Keep completed entities briefly recoverable via the cache, drop from live set.
    this.cache(entity);
    this.entities.delete(entity.id);
  }

  destroy(id: string): void {
    if (!this.entities.delete(id)) return;
    this.eventBus.emit("entity:destroyed", { entityId: id });
  }

  // ---- Validation ----------------------------------------------------------

  validate(entity: TransferableEntity): ValidationResult {
    if (!entity.permissions.transferable) return { ok: false, reason: "not transferable" };
    if (entity.expiresAt && entity.expiresAt < Date.now()) return { ok: false, reason: "expired" };
    const size = entity.metadata.sizeBytes;
    if (size !== undefined && size > this.options.maxEntityBytes) {
      return { ok: false, reason: "exceeds max entity size" };
    }
    return { ok: true };
  }

  // ---- Serialization -------------------------------------------------------

  /** Encode an entity's payload to bytes for encryption/transport. */
  encodePayload(entity: TransferableEntity): { data: Buffer; encoding: PayloadEncoding } {
    if (Buffer.isBuffer(entity.payload)) {
      return { data: entity.payload, encoding: "base64" };
    }
    return { data: Buffer.from(JSON.stringify(entity.payload ?? null), "utf8"), encoding: "json" };
  }

  decodePayload(bytes: Buffer, encoding: PayloadEncoding): unknown {
    if (encoding === "base64") return bytes;
    return JSON.parse(bytes.toString("utf8"));
  }

  /** Build the wire form given an already-encoded (possibly encrypted) payload. */
  buildSerialized(
    entity: TransferableEntity,
    payloadBase64: string,
    encoding: PayloadEncoding,
    encryption?: TransferableEntity["encryption"],
  ): SerializedEntity {
    return {
      id: entity.id,
      type: entity.type,
      owner: entity.owner,
      metadata: entity.metadata,
      ...(entity.preview !== undefined ? { preview: entity.preview } : {}),
      permissions: entity.permissions,
      createdAt: entity.createdAt,
      ...(entity.expiresAt !== undefined ? { expiresAt: entity.expiresAt } : {}),
      payload: payloadBase64,
      payloadEncoding: encoding,
      ...(encryption !== undefined ? { encryption } : {}),
    };
  }

  /** Reconstruct an entity from a wire form and its already-decoded payload. */
  fromSerialized(serialized: SerializedEntity, payload: unknown): TransferableEntity {
    return {
      id: serialized.id,
      type: serialized.type,
      owner: serialized.owner,
      state: EntityState.Received,
      metadata: serialized.metadata,
      ...(serialized.preview !== undefined ? { preview: serialized.preview } : {}),
      permissions: serialized.permissions,
      ...(serialized.encryption !== undefined ? { encryption: serialized.encryption } : {}),
      payload,
      createdAt: serialized.createdAt,
      ...(serialized.expiresAt !== undefined ? { expiresAt: serialized.expiresAt } : {}),
    };
  }

  // ---- Cache & history -----------------------------------------------------

  cache(entity: TransferableEntity): void {
    this.cacheStore.set(entity.id, { ...entity });
    while (this.cacheStore.size > this.options.cacheLimit) {
      const oldest = this.cacheStore.keys().next().value;
      if (oldest === undefined) break;
      this.cacheStore.delete(oldest);
    }
  }
  recover(id: string): TransferableEntity | undefined {
    const cached = this.cacheStore.get(id);
    return cached ? { ...cached } : undefined;
  }
  history(): readonly TransferHistoryEntry[] {
    return this.historyLog;
  }
}
