import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AirShareNode } from "../src/core/airShareNode.js";
import type { AirShareEventMap, AirShareEventName } from "../src/types/events.js";

/** Create a throwaway data directory for a node under test. */
export async function tempDataDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "air-share-test", randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanup(dir: string): Promise<void> {
  // Retry: a node's atomic JSON write (temp file + rename) can land a file just
  // as rm scans the directory, causing a transient ENOTEMPTY.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Resolve when `node` emits `event`, or reject after `timeoutMs`. */
export function waitFor<K extends AirShareEventName>(
  node: AirShareNode,
  event: K,
  timeoutMs = 5000,
  predicate: (payload: AirShareEventMap[K]) => boolean = () => true,
): Promise<AirShareEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const off = node.on(event, (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}
