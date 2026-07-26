/**
 * Plugin registry — providers and sinks.
 *
 * Purpose: Air Share is a runtime that routes entities to plugins without
 * knowing what they do. A `EntityProvider` produces an entity on the *source*
 * (e.g. "grab the clipboard"); an `EntitySink` consumes a received entity on the
 * *destination* (e.g. "drop into the clipboard", "open in VS Code"). Phase 4/5
 * ship real providers/sinks; Phase 3 defines the contracts and the router, and
 * tests use mock ones.
 *
 * The runtime depends only on these interfaces — new capabilities register
 * themselves and are routed generically.
 */

import type {
  EntityType,
  EntityDraft,
  GrabContext,
  TransferableEntity,
  TransferAction,
  PluginPermissions,
} from "../types/transfer.js";
import type { Logger } from "../utils/logger.js";

/** Produces an entity when a hand grabs something (source side). */
export interface EntityProvider {
  readonly name: string;
  /** Entity types this provider can produce. */
  readonly types: EntityType[];
  /** Higher priority providers are consulted first. Default 0. */
  readonly priority?: number;
  /** Declared capabilities/requirements (advisory). */
  readonly permissions?: PluginPermissions;
  /** Fast pre-check: can this provider produce anything for this grab? */
  canProvide?(context: GrabContext): boolean;
  /** Return a draft entity for this grab, or undefined to decline. */
  capture(context: GrabContext): Promise<EntityDraft | undefined> | EntityDraft | undefined;
}

/** Consumes a received entity and performs an action (destination side). */
export interface EntitySink {
  readonly name: string;
  readonly types: EntityType[];
  readonly actions: TransferAction[];
  readonly priority?: number;
  /** Declared capabilities/requirements (advisory). */
  readonly permissions?: PluginPermissions;
  /** Override for finer control than (types × actions). */
  canHandle?(entity: TransferableEntity, action: TransferAction): boolean;
  /** Perform the action with the entity. */
  drop(entity: TransferableEntity, action: TransferAction): Promise<void> | void;
}

/** A bundle of providers and/or sinks registered together. */
export interface TransferPlugin {
  readonly name: string;
  readonly providers?: EntityProvider[];
  readonly sinks?: EntitySink[];
}

function byPriority<T extends { priority?: number }>(a: T, b: T): number {
  return (b.priority ?? 0) - (a.priority ?? 0);
}

export class PluginRegistry {
  private readonly providers: EntityProvider[] = [];
  private readonly sinks: EntitySink[] = [];

  constructor(private readonly logger: Logger) {}

  register(plugin: TransferPlugin): void {
    plugin.providers?.forEach((p) => this.registerProvider(p));
    plugin.sinks?.forEach((s) => this.registerSink(s));
    this.logger.info("plugin registered", {
      name: plugin.name,
      providers: plugin.providers?.length ?? 0,
      sinks: plugin.sinks?.length ?? 0,
    });
  }

  registerProvider(provider: EntityProvider): void {
    this.providers.push(provider);
    this.providers.sort(byPriority);
  }
  registerSink(sink: EntitySink): void {
    this.sinks.push(sink);
    this.sinks.sort(byPriority);
  }

  /** Ask providers, in priority order, to produce an entity for this grab. */
  async resolveProvider(context: GrabContext): Promise<EntityDraft | undefined> {
    for (const provider of this.providers) {
      try {
        if (provider.canProvide && !provider.canProvide(context)) continue;
        const entity = await provider.capture(context);
        if (entity) return entity;
      } catch (error) {
        this.logger.warn("provider capture failed", {
          provider: provider.name,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return undefined;
  }

  /** Find the best sink for a received entity + action. */
  resolveSink(entity: TransferableEntity, action: TransferAction): EntitySink | undefined {
    return this.sinks.find((sink) => this.sinkMatches(sink, entity, action));
  }

  private sinkMatches(sink: EntitySink, entity: TransferableEntity, action: TransferAction): boolean {
    if (sink.canHandle) return sink.canHandle(entity, action);
    return sink.types.includes(entity.type) && sink.actions.includes(action);
  }

  get providerCount(): number {
    return this.providers.length;
  }
  get sinkCount(): number {
    return this.sinks.length;
  }
}
