/**
 * Action engine — what a transfer *means*, decoupled from how it moves.
 *
 * Air Share is a cross-device interaction runtime, not a file copier: every
 * entity carries a `TransferAction` (copy, move, open, mirror, cast, …). This
 * module owns two pluggable seams:
 *
 *  - `ActionResolver` (source): decides which action a release implies. The
 *    default returns the configured default, honouring a per-hand override so a
 *    future modifier gesture can say "move" or "open" instead of "copy".
 *  - `ActionExecutor` (destination): a registry mapping an action to a handler.
 *    When no handler is registered for an action, the runtime falls back to its
 *    normal sink delivery — so this is purely additive. Handlers here perform
 *    *runtime* routing only; real OS behaviour (launching an app, running an
 *    installer) arrives with the Phase-5B content providers, not here.
 */

import type { TransferableEntity, TransferAction, VirtualHand } from "../types/transfer.js";

// ---- Source side -----------------------------------------------------------

export interface ActionContext {
  hand: VirtualHand;
}

export interface ActionResolver {
  resolve(entity: TransferableEntity, context: ActionContext): TransferAction;
}

/** Returns the hand's explicitly-chosen action, else the configured default. */
export class DefaultActionResolver implements ActionResolver {
  constructor(private readonly defaultAction: TransferAction) {}
  resolve(_entity: TransferableEntity, context: ActionContext): TransferAction {
    return context.hand.action ?? this.defaultAction;
  }
}

// ---- Destination side ------------------------------------------------------

export interface ActionExecuteContext {
  transferId: string;
  sender: string;
}

export type ActionHandler = (
  entity: TransferableEntity,
  action: TransferAction,
  context: ActionExecuteContext,
) => Promise<void> | void;

/**
 * A registry of per-action handlers. The runtime consults it before falling
 * back to sink delivery: a registered handler fully owns that action.
 */
export class ActionExecutor {
  private readonly handlers = new Map<TransferAction, ActionHandler>();

  register(action: TransferAction, handler: ActionHandler): this {
    this.handlers.set(action, handler);
    return this;
  }

  has(action: TransferAction): boolean {
    return this.handlers.has(action);
  }

  async execute(
    entity: TransferableEntity,
    action: TransferAction,
    context: ActionExecuteContext,
  ): Promise<void> {
    const handler = this.handlers.get(action);
    if (!handler) throw new Error(`no handler registered for action '${action}'`);
    await handler(entity, action, context);
  }
}
