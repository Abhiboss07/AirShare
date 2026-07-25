/**
 * Transfer Runtime configuration.
 *
 * Purpose: all runtime tunables in one typed place with documented defaults.
 */

import { TransferAction } from "../types/transfer.js";

export interface TransferConfig {
  /** Reject entities larger than this (bytes). */
  maxEntityBytes: number;
  /** Bounded transfer history length. */
  historyLimit: number;
  /** At-rest recovery cache size (entities). */
  cacheLimit: number;
  /** Default action applied when a hand drops onto a device. */
  defaultAction: TransferAction;
  /** Require a resolved target device before a release triggers a transfer. */
  requireTargetForTransfer: boolean;
}

export const DEFAULT_TRANSFER_CONFIG: TransferConfig = {
  maxEntityBytes: 64 * 1024 * 1024, // 64 MiB
  historyLimit: 100,
  cacheLimit: 50,
  defaultAction: TransferAction.Copy,
  requireTargetForTransfer: true,
};

export function loadTransferConfig(overrides: Partial<TransferConfig> = {}): TransferConfig {
  return { ...DEFAULT_TRANSFER_CONFIG, ...overrides };
}
