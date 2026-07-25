/**
 * Mesh integration layer (Phase 4).
 *
 * Purpose: bridge the Phase-1 networking node and the Phase-3 Transfer Runtime so
 * transfers run over the *real* secure device mesh instead of the in-memory
 * loopback. This is the composition seam — the only module allowed to import both
 * `core`/`network` and `transfer`; vision/transfer/network still never import
 * each other.
 *
 * `attachTransferMesh(node, opts)` wires: AirShareNode → MeshMessenger →
 * MeshTransferTransport → TransferScheduler → TransferRuntime, plus capability
 * negotiation. Call it after `node.start()`.
 */

import { createLogger } from "../utils/logger.js";
import { AirShareNodeMessenger, type MeshMessenger } from "./messenger.js";
import {
  MeshTransferTransport,
  DEFAULT_MESH_TRANSPORT_OPTIONS,
  type MeshTransportOptions,
} from "./meshTransport.js";
import { CapabilityService } from "./capabilityService.js";
import {
  TransferScheduler,
  DEFAULT_SCHEDULER_CONFIG,
  type SchedulerConfig,
} from "../transfer/scheduler.js";
import { composeTransferRuntime, type ComposedRuntime } from "../transfer/index.js";
import { NoopCipher, type EntityCipher } from "../transfer/entityCipher.js";
import { StaticTargetResolver, type TargetResolver } from "../transfer/targetResolver.js";
import type { EntityProvider, EntitySink } from "../transfer/registry.js";
import type { TransferConfig } from "../transfer/config.js";
import type { AirShareNode } from "../core/airShareNode.js";

export interface AttachMeshOptions {
  /** Capability document version string. */
  version?: string;
  /** Feature capabilities this device advertises to peers. */
  supports?: string[];
  /** Entity cipher. Defaults to Noop because the mesh session already encrypts. */
  cipher?: EntityCipher;
  /** How a hand's aim resolves to a target device. */
  targetResolver?: TargetResolver;
  transferConfig?: Partial<TransferConfig>;
  scheduler?: Partial<SchedulerConfig>;
  meshTransport?: Partial<MeshTransportOptions>;
  providers?: EntityProvider[];
  sinks?: EntitySink[];
}

export interface MeshTransferSystem extends ComposedRuntime {
  messenger: MeshMessenger;
  transport: MeshTransferTransport;
  scheduler: TransferScheduler;
  capabilities: CapabilityService;
  /** Tear down subscriptions (does not stop the underlying node). */
  detach(): void;
}

/**
 * Compose the whole transfer-over-mesh system on top of a started AirShareNode.
 */
export function attachTransferMesh(
  node: AirShareNode,
  options: AttachMeshOptions = {},
): MeshTransferSystem {
  const logger = createLogger("mesh", node.config.logLevel);
  const messenger = new AirShareNodeMessenger(node);

  const transport = new MeshTransferTransport(messenger, node.events, logger.child("transport"), {
    ...DEFAULT_MESH_TRANSPORT_OPTIONS,
    ...options.meshTransport,
  });
  const scheduler = new TransferScheduler(
    transport,
    { ...DEFAULT_SCHEDULER_CONFIG, ...options.scheduler },
    logger.child("scheduler"),
  );

  const composed = composeTransferRuntime({
    localDeviceId: node.identityInfo.id,
    eventBus: node.events,
    transport: scheduler,
    logger,
    cipher: options.cipher ?? new NoopCipher(),
    targetResolver: options.targetResolver ?? new StaticTargetResolver(undefined),
    ...(options.transferConfig ? { config: options.transferConfig } : {}),
  });

  options.providers?.forEach((p) => composed.registry.registerProvider(p));
  options.sinks?.forEach((s) => composed.registry.registerSink(s));

  const capabilities = new CapabilityService(
    messenger,
    node.events,
    {
      device: node.identityInfo.id,
      version: options.version ?? "1.0",
      supports: options.supports ?? ["transfer"],
    },
    logger.child("capabilities"),
  );
  capabilities.attach();
  composed.runtime.attach();

  return {
    ...composed,
    messenger,
    transport,
    scheduler,
    capabilities,
    detach: () => {
      composed.runtime.detach();
      capabilities.detach();
    },
  };
}

export {
  MeshTransferTransport,
  CHANNEL_TRANSFER,
  CHANNEL_ACK,
  type MeshTransportOptions,
} from "./meshTransport.js";
export { AirShareNodeMessenger, type MeshMessenger } from "./messenger.js";
export { CapabilityService, CHANNEL_CAPABILITIES } from "./capabilityService.js";
// TransferScheduler is exported via the transfer barrel; not re-exported here to
// avoid an ambiguous star-export through the top-level index.
