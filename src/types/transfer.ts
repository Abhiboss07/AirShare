/**
 * Transfer Runtime shared vocabulary.
 *
 * Purpose: the common language of the Transfer Runtime — the entities that flow
 * between devices, their lifecycle states, the actions performed on them, and
 * the virtual-hand model. Lives in `types/` (the shared contract layer) so the
 * runtime, providers/plugins, and eventually the networking layer all speak it
 * without depending on each other's implementations.
 *
 * Design note: Air Share is a *cross-device interaction runtime*, not a file
 * transfer app. Everything transferable — text, image, clipboard, file, browser
 * tab, screen region, AI selection, future plugin types — is a
 * `TransferableEntity`. One runtime carries them all.
 */

/** The kinds of things Air Share can carry. Extend freely for new providers. */
export enum EntityType {
  Text = "text",
  Image = "image",
  Clipboard = "clipboard",
  File = "file",
  Files = "files",
  Folder = "folder",
  BrowserTab = "browser-tab",
  Window = "window",
  VideoStream = "video-stream",
  Audio = "audio",
  ScreenRegion = "screen-region",
  AiSelection = "ai-selection",
  Custom = "custom",
}

/** What to do with an entity on the destination. Huawei mostly does COPY. */
export enum TransferAction {
  Copy = "copy",
  Move = "move",
  Stream = "stream",
  Open = "open",
  Install = "install",
  Sync = "sync",
  Mirror = "mirror",
  Paste = "paste",
  Share = "share",
  Cast = "cast",
}

/**
 * The full entity lifecycle. A source instance walks CREATED→…→IN_TRANSIT→
 * COMPLETED; a destination instance walks RECEIVED→…→COMPLETED. HELD can be
 * released to DROPPED (put down, no send) or committed via VALIDATED.
 */
export enum EntityState {
  Created = "CREATED",
  Selected = "SELECTED",
  Locked = "LOCKED",
  Held = "HELD",
  Validated = "VALIDATED",
  Encrypted = "ENCRYPTED",
  Queued = "QUEUED",
  Sending = "SENDING",
  InTransit = "IN_TRANSIT",
  Received = "RECEIVED",
  Decrypted = "DECRYPTED",
  Ready = "READY",
  Dropped = "DROPPED",
  Completed = "COMPLETED",
  Cancelled = "CANCELLED",
  Failed = "FAILED",
}

export interface EntityPermissions {
  transferable: boolean;
  persistable: boolean;
  requiresApproval?: boolean;
}

/** Encryption metadata attached to a serialized/at-rest payload. */
export interface EntityEncryption {
  algorithm: string;
  keyId?: string;
  iv?: string;
  tag?: string;
}

export interface EntityMetadata {
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  [key: string]: unknown;
}

export interface EntityPreview {
  kind: "text" | "image" | "icon" | "none";
  text?: string;
  thumbnailBase64?: string;
}

/**
 * The base runtime object. Concrete providers narrow `type` and `payload` via
 * the sub-interfaces below, but the runtime only ever depends on this shape.
 */
export interface TransferableEntity<TPayload = unknown> {
  id: string;
  type: EntityType;
  /** deviceId of the origin. */
  owner: string;
  state: EntityState;
  metadata: EntityMetadata;
  payload: TPayload;
  preview?: EntityPreview;
  permissions: EntityPermissions;
  encryption?: EntityEncryption;
  createdAt: number;
  expiresAt?: number;
}

// ---- Concrete entity shapes (providers produce these) ----------------------

export interface TextEntity extends TransferableEntity<string> {
  type: EntityType.Text;
}
export interface ImageEntity extends TransferableEntity<{ dataBase64: string; width?: number; height?: number }> {
  type: EntityType.Image;
}
export interface ClipboardEntity extends TransferableEntity<{ formats: Record<string, string> }> {
  type: EntityType.Clipboard;
}
export interface FileEntity extends TransferableEntity<{ path?: string; dataBase64?: string }> {
  type: EntityType.File;
}

// ---- Wire / serialization --------------------------------------------------

export type PayloadEncoding = "json" | "base64";

export interface SerializedEntity {
  id: string;
  type: EntityType;
  owner: string;
  metadata: EntityMetadata;
  preview?: EntityPreview;
  permissions: EntityPermissions;
  createdAt: number;
  expiresAt?: number;
  /** Encoded payload — base64 of ciphertext when encrypted, else per encoding. */
  payload: string;
  payloadEncoding: PayloadEncoding;
  encryption?: EntityEncryption;
}

export interface TransferEnvelope {
  transferId: string;
  action: TransferAction;
  sender: string;
  target: string;
  entity: SerializedEntity;
}

export interface TransferAck {
  transferId: string;
  accepted: boolean;
  reason?: string;
  /** Destination-clock timestamps, for latency measurement (optional). */
  receivedAt?: number;
  processedAt?: number;
}

/**
 * End-to-end timing for a transfer. `rttMs` and `processingMs` are computed on a
 * single clock each (safe); `estimatedNetworkMs` is an approximation because the
 * two devices' clocks are not synchronized.
 */
export interface TransferMetrics {
  transferId: string;
  entityId?: string;
  targetDeviceId?: string;
  sentAt: number;
  ackAt: number;
  rttMs: number;
  processingMs?: number;
  estimatedNetworkMs?: number;
  bytes?: number;
}

/**
 * A structured description of one feature a device offers. Richer than a bare
 * "supported" flag so peers can reason about read/write direction, streaming,
 * and size limits before attempting a doomed transfer.
 */
export interface CapabilityFeature {
  read?: boolean;
  write?: boolean;
  streaming?: boolean;
  /** Largest payload this feature accepts, in bytes. */
  maxBytes?: number;
  version?: string;
}

/** A device's advertised capabilities, exchanged after connection. */
export interface CapabilityDoc {
  device: string;
  version: string;
  /** Coarse feature list (back-compat, always present). */
  supports: string[];
  /** Optional richer per-feature detail keyed by feature name. */
  matrix?: Record<string, CapabilityFeature>;
}

// ---- Virtual hand ----------------------------------------------------------

/** Per-hand interaction state maintained by the runtime (never by vision). */
export interface VirtualHand {
  handId: string;
  handedness: "left" | "right" | "unknown";
  holding: boolean;
  entityId?: string | undefined;
  confidence: number;
  targetDeviceId?: string | undefined;
  /** Action a modifier gesture selected for this hand; falls back to default. */
  action?: TransferAction | undefined;
  lastGesture?: string | undefined;
  updatedAt: number;
}

/**
 * What a provider returns from `capture`: an entity without the fields the
 * runtime assigns (id, state, createdAt, and owner — the local device).
 */
export type EntityDraft = Omit<
  TransferableEntity,
  "id" | "state" | "createdAt" | "owner"
> & { owner?: string };

/** Context passed to providers when a hand attempts to grab something. */
export interface GrabContext {
  handId: string;
  handedness: "left" | "right" | "unknown";
  position: { x: number; y: number };
  timestamp: number;
}
