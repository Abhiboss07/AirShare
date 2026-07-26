/**
 * Content layer (Phase 5B) — real providers/sinks that produce and consume OS
 * content (clipboard, text, image, file, browser).
 *
 * This is a sibling of vision/transfer/network: it implements the `transfer/`
 * plugin interfaces and touches the OS through injectable backends, but imports
 * nothing from network or vision. Plug the plugins into a mesh system via the
 * existing `attachTransferMesh({ providers, sinks })` options.
 */

import { createLogger, type Logger } from "../utils/logger.js";
import type { EntityProvider, EntitySink } from "../transfer/registry.js";
import {
  ExecCommandRunner,
  NodeFileBackend,
  XdgUrlOpener,
  detectClipboardBackend,
  type ClipboardBackend,
  type CommandRunner,
  type FileBackend,
  type UrlOpener,
} from "./backends/index.js";
import { clipboardProvider, clipboardSink } from "./providers/clipboard.js";
import { clipboardImageProvider, imageSink } from "./providers/image.js";
import { fileSink } from "./providers/file.js";
import { browserSink } from "./providers/browser.js";

export * from "./backends/index.js";
export * from "./providers/index.js";
export { CONTENT_PRIORITY } from "./priorities.js";

export interface DefaultContentOptions {
  /** Clipboard backend; auto-detected (Wayland/X11/in-memory) when omitted. */
  clipboard?: ClipboardBackend;
  /** Command runner for the OS backends; defaults to a real `execFile` runner. */
  runner?: CommandRunner;
  logger?: Logger;
  /** Filesystem backend for the file sink; defaults to the real filesystem. */
  fileBackend?: FileBackend;
  /** Enables the file sink, writing received files here. */
  downloadDir?: string;
  /** URL opener for the browser sink; defaults to `xdg-open`. */
  urlOpener?: UrlOpener;
  /** Include clipboard-image provider + image sink (default true). */
  includeImage?: boolean;
  /** Include the browser sink (default true). */
  includeBrowser?: boolean;
}

/**
 * Detect backends and assemble a ready-to-use plugin set. Pass the result
 * straight to `attachTransferMesh({ providers, sinks })`.
 */
export async function defaultContentPlugins(
  options: DefaultContentOptions = {},
): Promise<{ providers: EntityProvider[]; sinks: EntitySink[] }> {
  const logger = options.logger ?? createLogger("content", "info");
  const runner = options.runner ?? new ExecCommandRunner();
  const clipboard = options.clipboard ?? (await detectClipboardBackend(runner, logger));
  const includeImage = options.includeImage ?? true;
  const includeBrowser = options.includeBrowser ?? true;

  const providers: EntityProvider[] = [clipboardProvider(clipboard)];
  const sinks: EntitySink[] = [clipboardSink(clipboard)];

  if (includeImage) {
    providers.push(clipboardImageProvider(clipboard));
    sinks.push(imageSink(clipboard));
  }
  if (options.downloadDir) {
    const fileBackend = options.fileBackend ?? new NodeFileBackend();
    sinks.push(fileSink(fileBackend, options.downloadDir));
  }
  if (includeBrowser) {
    const opener = options.urlOpener ?? new XdgUrlOpener(runner);
    sinks.push(browserSink(opener));
  }

  return { providers, sinks };
}
