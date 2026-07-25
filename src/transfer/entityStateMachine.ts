/**
 * EntityStateMachine — the entity lifecycle authority.
 *
 * Purpose: enforce legal state transitions for a `TransferableEntity` so the
 * runtime can never advance an entity into an inconsistent state. Pure and
 * table-driven, so the whole lifecycle is unit-testable in isolation.
 *
 * Source instances walk CREATED→SELECTED→LOCKED→HELD→VALIDATED→ENCRYPTED→
 * QUEUED→SENDING→IN_TRANSIT→COMPLETED. Destination instances walk RECEIVED→
 * DECRYPTED→READY→DROPPED→COMPLETED. HELD may DROP (put down) instead of send.
 * Any active state may FAIL or CANCEL.
 */

import { EntityState } from "../types/transfer.js";

const TERMINAL = new Set<EntityState>([
  EntityState.Completed,
  EntityState.Cancelled,
  EntityState.Failed,
]);

/** Allowed forward transitions. FAIL/CANCEL edges are added generically below. */
const BASE_TRANSITIONS: Record<EntityState, EntityState[]> = {
  [EntityState.Created]: [EntityState.Selected],
  [EntityState.Selected]: [EntityState.Locked, EntityState.Dropped],
  [EntityState.Locked]: [EntityState.Held],
  [EntityState.Held]: [EntityState.Validated, EntityState.Dropped],
  [EntityState.Validated]: [EntityState.Encrypted],
  [EntityState.Encrypted]: [EntityState.Queued],
  [EntityState.Queued]: [EntityState.Sending],
  [EntityState.Sending]: [EntityState.InTransit],
  [EntityState.InTransit]: [EntityState.Completed],
  // destination path
  [EntityState.Received]: [EntityState.Decrypted],
  [EntityState.Decrypted]: [EntityState.Ready],
  [EntityState.Ready]: [EntityState.Dropped],
  [EntityState.Dropped]: [EntityState.Completed],
  // terminals
  [EntityState.Completed]: [],
  [EntityState.Cancelled]: [],
  [EntityState.Failed]: [],
};

/** States from which CANCEL is still allowed (before the point of no return). */
const CANCELLABLE = new Set<EntityState>([
  EntityState.Created,
  EntityState.Selected,
  EntityState.Locked,
  EntityState.Held,
  EntityState.Validated,
  EntityState.Encrypted,
  EntityState.Queued,
]);

export function isTerminal(state: EntityState): boolean {
  return TERMINAL.has(state);
}

export function allowedTransitions(from: EntityState): EntityState[] {
  const base = [...(BASE_TRANSITIONS[from] ?? [])];
  if (!isTerminal(from)) base.push(EntityState.Failed);
  if (CANCELLABLE.has(from)) base.push(EntityState.Cancelled);
  return base;
}

export function canTransition(from: EntityState, to: EntityState): boolean {
  return allowedTransitions(from).includes(to);
}

export class InvalidTransitionError extends Error {
  override readonly name = "InvalidTransitionError";
  constructor(
    readonly from: EntityState,
    readonly to: EntityState,
  ) {
    super(`illegal entity transition ${from} -> ${to}`);
  }
}

/**
 * A thin stateful wrapper for one entity's state. Kept separate from the entity
 * object so transition rules live in one place and are trivially testable.
 */
export class EntityStateMachine {
  constructor(private state: EntityState = EntityState.Created) {}

  get current(): EntityState {
    return this.state;
  }
  get terminal(): boolean {
    return isTerminal(this.state);
  }

  can(to: EntityState): boolean {
    return canTransition(this.state, to);
  }

  /** Advance to `to`, or throw InvalidTransitionError. Returns the prior state. */
  transition(to: EntityState): EntityState {
    if (!this.can(to)) throw new InvalidTransitionError(this.state, to);
    const from = this.state;
    this.state = to;
    return from;
  }

  /** Try to advance; returns false instead of throwing on an illegal move. */
  tryTransition(to: EntityState): boolean {
    if (!this.can(to)) return false;
    this.state = to;
    return true;
  }
}
