/**
 * Transfer Runtime public API (Phase 3).
 *
 * Air Share as a cross-device interaction runtime: gestures grab
 * `TransferableEntity` objects, the runtime runs them through a lifecycle and an
 * action pipeline, and plugins (providers/sinks) supply and consume content.
 * Networking is behind `ITransferTransport` (Phase 5).
 */

import type { IEventBus } from "../events/eventBus.js";
import type { Logger } from "../utils/logger.js";
import { EntityManager } from "./entityManager.js";
import { PluginRegistry } from "./registry.js";
import { VirtualHandRegistry } from "./virtualHand.js";
import { TransferRuntime } from "./transferRuntime.js";
import { NoopCipher, type EntityCipher } from "./entityCipher.js";
import type { ITransferTransport } from "./transport.js";
import { StaticTargetResolver, type TargetResolver } from "./targetResolver.js";
import { loadTransferConfig, type TransferConfig } from "./config.js";

export interface ComposeOptions {
  localDeviceId: string;
  eventBus: IEventBus;
  transport: ITransferTransport;
  logger: Logger;
  cipher?: EntityCipher;
  targetResolver?: TargetResolver;
  config?: Partial<TransferConfig>;
}

export interface ComposedRuntime {
  runtime: TransferRuntime;
  entities: EntityManager;
  registry: PluginRegistry;
  hands: VirtualHandRegistry;
  config: TransferConfig;
}

/**
 * Wire an entire Transfer Runtime from its collaborators. This is the single
 * place dependency injection happens for the transfer layer (mirrors
 * AirShareNode for networking).
 */
export function composeTransferRuntime(options: ComposeOptions): ComposedRuntime {
  const config = loadTransferConfig(options.config);
  const entities = new EntityManager(
    options.eventBus,
    {
      maxEntityBytes: config.maxEntityBytes,
      historyLimit: config.historyLimit,
      cacheLimit: config.cacheLimit,
    },
    options.logger.child("entities"),
  );
  const registry = new PluginRegistry(options.logger.child("plugins"));
  const hands = new VirtualHandRegistry(options.eventBus);
  const runtime = new TransferRuntime({
    localDeviceId: options.localDeviceId,
    eventBus: options.eventBus,
    entities,
    registry,
    hands,
    cipher: options.cipher ?? new NoopCipher(),
    transport: options.transport,
    targetResolver: options.targetResolver ?? new StaticTargetResolver(undefined),
    config,
    logger: options.logger.child("transfer"),
  });
  return { runtime, entities, registry, hands, config };
}

export { TransferRuntime, type TransferRuntimeDeps } from "./transferRuntime.js";
export { EntityManager } from "./entityManager.js";
export type {
  EntityManagerOptions,
  EntityInput,
  TransferHistoryEntry,
  ValidationResult,
} from "./entityManager.js";
export {
  EntityStateMachine,
  canTransition,
  allowedTransitions,
  isTerminal,
  InvalidTransitionError,
} from "./entityStateMachine.js";
export {
  PluginRegistry,
  type EntityProvider,
  type EntitySink,
  type TransferPlugin,
} from "./registry.js";
export { VirtualHandRegistry } from "./virtualHand.js";
export { NoopCipher, AesGcmCipher, type EntityCipher } from "./entityCipher.js";
export {
  InMemoryTransferSwitch,
  InMemoryTransferTransport,
  BaseTransferTransport,
  NotImplementedError,
  type ITransferTransport,
  type ReceiveHandler,
  type StreamMeta,
} from "./transport.js";
export {
  TransferScheduler,
  DEFAULT_SCHEDULER_CONFIG,
  type SchedulerConfig,
} from "./scheduler.js";
export {
  StaticTargetResolver,
  type TargetResolver,
  type TargetContext,
} from "./targetResolver.js";
export {
  loadTransferConfig,
  DEFAULT_TRANSFER_CONFIG,
  type TransferConfig,
} from "./config.js";
