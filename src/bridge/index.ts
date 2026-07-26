/**
 * Experience bridge (Phase 6) — hosts the visual layer on top of the real mesh.
 *
 * The browser stays a thin client (camera + MediaPipe + rendering); this Node
 * bridge owns the real AirShareNodes, VisionEngine and transfer runtime and
 * relays a curated slice of the event bus to the UI. See ExperienceBridge.
 */

import { ExperienceBridge, type ExperienceOptions } from "./bridgeServer.js";

export { ExperienceBridge, type ExperienceOptions } from "./bridgeServer.js";
export * from "./protocol.js";

/** Start the experience bridge and return the URL to open in a browser. */
export async function startExperience(
  options: ExperienceOptions = {},
): Promise<{ bridge: ExperienceBridge; url: string; port: number }> {
  const bridge = new ExperienceBridge(options);
  const { url, port } = await bridge.start();
  return { bridge, url, port };
}
