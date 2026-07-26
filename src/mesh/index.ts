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
import type { EntityCipher } from "../transfer/entityCipher.js";
import type { CipherProvider } from "../transfer/cipherProvider.js";
import { SessionKeyedCipherProvider } from "./sessionCipher.js";
import { RegistryTargetResolver, type TargetResolver } from "../transfer/targetResolver.js";
import type { ActionResolver, ActionExecutor } from "../transfer/actionEngine.js";
import type { EntityProvider, EntitySink } from "../transfer/registry.js";
import type { TransferConfig } from "../transfer/config.js";
import type { CapabilityFeature } from "../types/transfer.js";
import type { AirShareNode } from "../core/airShareNode.js";

export interface AttachMeshOptions {
  /** Capability document version string. */
  version?: string;
  /** Feature capabilities this device advertises to peers. */
  supports?: string[];
  /** Richer per-feature capability detail advertised to peers. */
  matrix?: Record<string, CapabilityFeature>;
  /**
   * Per-peer entity cipher. Defaults to a session-keyed AES-256-GCM cipher so
   * the object is encrypted end-to-end (independent of the transport session).
   */
  cipherProvider?: CipherProvider;
  /** Single cipher for all peers (back-compat shorthand). */
  cipher?: EntityCipher;
  /** How a hand's aim resolves to a target device. Defaults to connected peers. */
  targetResolver?: TargetResolver;
  /** Source-side action selection. */
  actionResolver?: ActionResolver;
  /** Destination-side per-action handlers. */
  actionExecutor?: ActionExecutor;
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
    node.events,
  );

  // Default: encrypt each object end-to-end with a key derived from the live
  // secure session (falls back to Noop until a session exists). Overridable.
  const cipherProvider =
    options.cipherProvider ??
    new SessionKeyedCipherProvider(messenger, logger.child("cipher"));
  // Default: aim resolves to the currently-connected peers.
  const targetResolver =
    options.targetResolver ??
    new RegistryTargetResolver(() => node.connectedDeviceIds());

  const composed = composeTransferRuntime({
    localDeviceId: node.identityInfo.id,
    eventBus: node.events,
    transport: scheduler,
    logger,
    ...(options.cipher !== undefined ? { cipher: options.cipher } : { cipherProvider }),
    targetResolver,
    ...(options.actionResolver ? { actionResolver: options.actionResolver } : {}),
    ...(options.actionExecutor ? { actionExecutor: options.actionExecutor } : {}),
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
      ...(options.matrix ? { matrix: options.matrix } : {}),
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
export { SessionKeyedCipherProvider } from "./sessionCipher.js";
// TransferScheduler is exported via the transfer barrel; not re-exported here to
// avoid an ambiguous star-export through the top-level index.
