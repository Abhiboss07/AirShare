/**
 * TransferRuntime — the orchestrator of the digital-object runtime.
 *
 * Purpose: the meeting point of the whole system. It subscribes to `gesture:*`
 * events on the bus, drives the VirtualHand model, asks providers to produce
 * entities on a grab, runs the encrypt→queue→send action pipeline on release,
 * and on the receiving side decrypts and routes entities to sinks. It advances
 * every entity through the `EntityStateMachine` and emits `transfer:*` events.
 *
 * Boundaries (by design):
 *  - Vision only *emits gestures*; it never calls the runtime.
 *  - Gestures never own entities — the runtime owns them via EntityManager.
 *  - The network is behind `ITransferTransport`; the runtime is transport-blind.
 *
 * Flow:  gesture → EventBus → TransferRuntime(VirtualHand) → EntityManager
 *        → action pipeline → ITransferTransport → (peer) → sink → drop
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import { newMessageId } from "../utils/ids.js";
import {
  EntityState,
  type EntityDraft,
  type GrabContext,
  type TransferAction,
  type TransferableEntity,
  type TransferAck,
  type TransferEnvelope,
} from "../types/transfer.js";
import type { EntityManager } from "./entityManager.js";
import type { PluginRegistry } from "./registry.js";
import type { VirtualHandRegistry } from "./virtualHand.js";
import type { EntityCipher } from "./entityCipher.js";
import type { ITransferTransport } from "./transport.js";
import type { TargetResolver } from "./targetResolver.js";
import type { TransferConfig } from "./config.js";

export interface TransferRuntimeDeps {
  localDeviceId: string;
  eventBus: IEventBus;
  entities: EntityManager;
  registry: PluginRegistry;
  hands: VirtualHandRegistry;
  cipher: EntityCipher;
  transport: ITransferTransport;
  targetResolver: TargetResolver;
  config: TransferConfig;
  logger: Logger;
}

export class TransferRuntime {
  private readonly unsubscribes: Array<() => void> = [];
  private attached = false;

  constructor(private readonly deps: TransferRuntimeDeps) {}

  /** Subscribe to gesture events and start accepting incoming transfers. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const bus = this.deps.eventBus;
    this.unsubscribes.push(
      bus.on("gesture:hand-detected", (e) => this.deps.hands.ensure(e.handId, e.handedness)),
      bus.on("gesture:pinch-start", (e) => void this.onGrab(e.handId, e.position)),
      bus.on("gesture:pinch-hold", (e) => this.deps.hands.update(e.handId, { holding: true })),
      bus.on("gesture:pinch-release", (e) => void this.onRelease(e.handId)),
      bus.on("gesture:point", (e) => this.onAim(e.handId, e.direction, e.position)),
      bus.on("gesture:open-palm", (e) => this.onCancel(e.handId)),
      bus.on("gesture:hand-lost", (e) => this.onHandLost(e.handId)),
    );
    this.deps.transport.onReceive((envelope) => this.receive(envelope));
    this.deps.logger.info("transfer runtime attached", { device: this.deps.localDeviceId });
  }

  detach(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.attached = false;
  }

  /** Programmatic grab (used by tests/tools that bypass real gestures). */
  async grab(handId: string, position = { x: 0.5, y: 0.5 }): Promise<TransferableEntity | undefined> {
    return this.onGrab(handId, position);
  }

  // ---- Source side ----------------------------------------------------------

  private async onGrab(
    handId: string,
    position: { x: number; y: number },
  ): Promise<TransferableEntity | undefined> {
    const hand = this.deps.hands.ensure(handId, "unknown");
    if (hand.entityId) return this.deps.entities.get(hand.entityId); // already holding

    const context: GrabContext = {
      handId,
      handedness: hand.handedness,
      position,
      timestamp: Date.now(),
    };
    const draft = await this.deps.registry.resolveProvider(context);
    if (!draft) {
      this.deps.logger.debug("grab produced nothing", { handId });
      return undefined;
    }

    const entity = this.deps.entities.create(this.materialize(draft));
    // CREATED → SELECTED → LOCKED → HELD (a pinch is a sustained hold).
    this.deps.entities.transition(entity.id, EntityState.Selected);
    this.deps.entities.transition(entity.id, EntityState.Locked);
    this.deps.entities.transition(entity.id, EntityState.Held);
    this.deps.hands.attachEntity(handId, entity.id);
    this.deps.eventBus.emit("hand:grab", {
      handId,
      entityId: entity.id,
      entityType: entity.type,
    });
    this.deps.logger.debug("hand grabbed entity", { handId, entityId: entity.id, type: entity.type });
    return entity;
  }

  private materialize(draft: EntityDraft): Parameters<EntityManager["create"]>[0] {
    return { ...draft, owner: draft.owner ?? this.deps.localDeviceId };
  }

  private onAim(
    handId: string,
    direction: { x: number; y: number },
    position: { x: number; y: number },
  ): void {
    const hand = this.deps.hands.get(handId);
    if (!hand) return;
    const target = this.deps.targetResolver.resolve(hand, { direction, position });
    if (target !== hand.targetDeviceId) {
      this.deps.hands.setTarget(handId, target);
      this.deps.eventBus.emit("hand:target-changed", { handId, targetDeviceId: target });
    }
  }

  private async onRelease(handId: string): Promise<void> {
    const hand = this.deps.hands.get(handId);
    if (!hand?.entityId) return;
    const entity = this.deps.entities.get(hand.entityId);
    this.deps.hands.detachEntity(handId);
    if (!entity) return;

    const target =
      hand.targetDeviceId ?? this.deps.targetResolver.resolve(hand, {}) ?? undefined;
    this.deps.eventBus.emit("hand:release", {
      handId,
      entityId: entity.id,
      ...(target !== undefined ? { targetDeviceId: target } : {}),
    });

    if (target) {
      await this.dispatch(entity, this.deps.config.defaultAction, target);
    } else {
      this.dropInPlace(entity); // released with no destination
    }
  }

  private onCancel(handId: string): void {
    const hand = this.deps.hands.get(handId);
    if (!hand?.entityId) return;
    const entity = this.deps.entities.get(hand.entityId);
    this.deps.hands.detachEntity(handId);
    if (entity) this.dropInPlace(entity);
  }

  private onHandLost(handId: string): void {
    this.onCancel(handId);
    this.deps.hands.remove(handId);
  }

  private dropInPlace(entity: TransferableEntity): void {
    // HELD → DROPPED → COMPLETED: put down locally, no transfer.
    this.deps.entities.transition(entity.id, EntityState.Dropped);
    this.deps.entities.transition(entity.id, EntityState.Completed);
  }

  /** The action pipeline: validate → encrypt → queue → send → complete. */
  private async dispatch(
    entity: TransferableEntity,
    action: TransferAction,
    target: string,
  ): Promise<void> {
    const transferId = newMessageId();
    try {
      const valid = this.deps.entities.validate(entity);
      if (!valid.ok) return this.failSource(entity, transferId, valid.reason ?? "invalid");

      this.deps.entities.transition(entity.id, EntityState.Validated);
      const { data, encoding } = this.deps.entities.encodePayload(entity);
      const { ciphertext, meta } = await this.deps.cipher.encrypt(data);
      this.deps.entities.transition(entity.id, EntityState.Encrypted);

      const serialized = this.deps.entities.buildSerialized(
        entity,
        ciphertext.toString("base64"),
        encoding,
        meta,
      );
      this.deps.entities.transition(entity.id, EntityState.Queued);

      const envelope: TransferEnvelope = {
        transferId,
        action,
        sender: this.deps.localDeviceId,
        target,
        entity: serialized,
      };
      this.deps.eventBus.emit("transfer:started", {
        transferId,
        entityId: entity.id,
        action,
        targetDeviceId: target,
      });

      this.deps.entities.transition(entity.id, EntityState.Sending);
      const ack = await this.deps.transport.send(envelope);
      this.deps.entities.transition(entity.id, EntityState.InTransit);

      if (ack.accepted) {
        this.deps.entities.transition(entity.id, EntityState.Completed);
        this.deps.eventBus.emit("transfer:completed", {
          transferId,
          entityId: entity.id,
          targetDeviceId: target,
        });
      } else {
        this.failSource(entity, transferId, ack.reason ?? "rejected by peer");
      }
    } catch (error) {
      this.failSource(entity, transferId, error instanceof Error ? error.message : String(error));
    }
  }

  private failSource(entity: TransferableEntity, transferId: string, reason: string): void {
    if (this.deps.entities.has(entity.id)) {
      this.deps.entities.transition(entity.id, EntityState.Failed);
    }
    this.deps.logger.warn("transfer failed", { entityId: entity.id, reason });
    this.deps.eventBus.emit("transfer:failed", { transferId, entityId: entity.id, reason });
  }

  // ---- Destination side -----------------------------------------------------

  private async receive(envelope: TransferEnvelope): Promise<TransferAck> {
    const s = envelope.entity;
    try {
      const ciphertext = Buffer.from(s.payload, "base64");
      const plaintext = await this.deps.cipher.decrypt(
        ciphertext,
        s.encryption ?? { algorithm: "none" },
      );
      const payload = this.deps.entities.decodePayload(plaintext, s.payloadEncoding);
      const entity = this.deps.entities.adopt(this.deps.entities.fromSerialized(s, payload));
      this.deps.eventBus.emit("transfer:received", {
        entityId: entity.id,
        type: entity.type,
        from: envelope.sender,
      });

      this.deps.entities.transition(entity.id, EntityState.Decrypted);
      const valid = this.deps.entities.validate(entity);
      if (!valid.ok) return this.failReceive(envelope, entity.id, valid.reason ?? "invalid");

      this.deps.entities.transition(entity.id, EntityState.Ready);
      const sink = this.deps.registry.resolveSink(entity, envelope.action);
      if (!sink) return this.failReceive(envelope, entity.id, "no sink for entity");

      await sink.drop(entity, envelope.action);
      this.deps.entities.transition(entity.id, EntityState.Dropped);
      this.deps.entities.transition(entity.id, EntityState.Completed);
      this.deps.eventBus.emit("transfer:completed", { transferId: envelope.transferId, entityId: entity.id });
      return { transferId: envelope.transferId, accepted: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.logger.error("receive failed", { reason });
      return { transferId: envelope.transferId, accepted: false, reason };
    }
  }

  private failReceive(envelope: TransferEnvelope, entityId: string, reason: string): TransferAck {
    if (this.deps.entities.has(entityId)) {
      this.deps.entities.transition(entityId, EntityState.Failed);
    }
    this.deps.eventBus.emit("transfer:failed", {
      transferId: envelope.transferId,
      entityId,
      reason,
    });
    return { transferId: envelope.transferId, accepted: false, reason };
  }
}
