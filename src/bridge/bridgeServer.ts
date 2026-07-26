/**
 * ExperienceBridge — the Node host behind the Phase-6 visual layer.
 *
 * Owns two real AirShareNodes on loopback (PC-A with camera-driven vision,
 * PC-B a receiver), serves the browser client over http, and relays a curated
 * slice of both event buses to connected browsers over WebSocket. Inbound
 * landmark frames from the browser are pushed into A's MediaPipeLandmarkSource,
 * so the *real* gesture→grab→E2E-encrypt→mesh→clipboard pipeline runs underneath
 * the animation.
 *
 * This is a composition seam (like mesh/): it imports core/vision/mesh/content;
 * nothing imports it. No runtime/mesh/vision code changes for Phase 6.
 */

import http from "node:http";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { AirShareNode } from "../core/airShareNode.js";
import { attachTransferMesh, type MeshTransferSystem } from "../mesh/index.js";
import { RegistryTargetResolver } from "../transfer/index.js";
import {
  InMemoryClipboardBackend,
  clipboardProvider,
  clipboardSink,
} from "../content/index.js";
import { VisionEngine } from "../vision/visionEngine.js";
import { MediaPipeLandmarkSource } from "../vision/mediapipeAdapter.js";
import { loadVisionConfig } from "../vision/config.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { LogLevel } from "../config/types.js";
import {
  FORWARDED_EVENTS,
  isBridgeInbound,
  type BridgeOutbound,
  type NodeTag,
} from "./protocol.js";
import type { AirShareEventName } from "../types/events.js";

export interface ExperienceOptions {
  /** Directory served to the browser (built client). */
  webRoot?: string;
  /** http+ws port. 0 (default) picks an ephemeral port. */
  port?: number;
  logLevel?: LogLevel;
  /** Seeds PC-A's clipboard so a pinch always has something to send. */
  clipboardText?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export class ExperienceBridge {
  private readonly logger: Logger;
  private readonly webRoot: string;
  private readonly clients = new Set<WebSocket>();
  private readonly unsubscribes: Array<() => void> = [];
  private readonly systems: MeshTransferSystem[] = [];
  private readonly dataDirs: string[] = [];

  private nodeA!: AirShareNode;
  private nodeB!: AirShareNode;
  private visionA!: VisionEngine;
  private sourceA!: MediaPipeLandmarkSource;
  private clipB!: InMemoryClipboardBackend;
  private httpServer: http.Server | undefined;
  private wss: WebSocketServer | undefined;

  constructor(private readonly options: ExperienceOptions = {}) {
    this.logger = createLogger("bridge", options.logLevel ?? "info");
    this.webRoot = options.webRoot ?? path.resolve(process.cwd(), "web");
  }

  /** Direct access to the source node (tests push landmarks / assert state). */
  get nodes(): { a: AirShareNode; b: AirShareNode } {
    return { a: this.nodeA, b: this.nodeB };
  }
  /** PC-B's clipboard (the drop target), for assertions. */
  get destinationClipboard(): InMemoryClipboardBackend {
    return this.clipB;
  }

  async start(): Promise<{ url: string; port: number }> {
    this.nodeA = this.makeNode("PC-A");
    this.nodeB = this.makeNode("PC-B");
    await this.nodeA.start();
    await this.nodeB.start();

    // Vision on A, fed by browser landmarks.
    this.sourceA = new MediaPipeLandmarkSource();
    this.visionA = new VisionEngine(
      this.nodeA.events,
      this.sourceA,
      loadVisionConfig(),
      this.logger.child("vision"),
    );
    await this.visionA.start();

    // Real transfer plumbing: A produces clipboard, B consumes it.
    const clipA = new InMemoryClipboardBackend(
      this.options.clipboardText ?? "Hello from PC-A — sent with a pinch ✋→📄→💻",
    );
    this.clipB = new InMemoryClipboardBackend();
    this.systems.push(
      attachTransferMesh(this.nodeA, {
        supports: ["transfer", "clipboard"],
        providers: [clipboardProvider(clipA)],
        targetResolver: new RegistryTargetResolver(() => this.nodeA.connectedDeviceIds()),
      }),
      attachTransferMesh(this.nodeB, {
        supports: ["transfer", "clipboard"],
        sinks: [clipboardSink(this.clipB)],
      }),
    );

    // Establish the secure link A↔B.
    const linked = Promise.all([this.once(this.nodeA, "device:connected"), this.once(this.nodeB, "device:connected")]);
    this.nodeA.connectTo("127.0.0.1", this.nodeB.port, this.nodeB.identityInfo.id);
    await linked;

    this.wireForwarding();
    return this.listen();
  }

  private makeNode(name: string): AirShareNode {
    // Each node needs its OWN data dir, else they share one identity (same
    // deviceId) and connectTo() early-returns thinking the peer is itself.
    const dataDir = path.join(os.tmpdir(), "air-share-bridge", randomUUID());
    this.dataDirs.push(dataDir);
    return new AirShareNode({
      enableDiscovery: false,
      config: {
        deviceName: name,
        dataDir,
        logLevel: "silent",
        network: { port: 0 },
        security: { requirePairingApproval: false },
      },
    });
  }

  /** Forward curated bus events (tagged by node) to every connected browser. */
  private wireForwarding(): void {
    const forwardFrom = (node: AirShareNode, tag: NodeTag): void => {
      for (const event of FORWARDED_EVENTS) {
        this.unsubscribes.push(
          node.on(event as AirShareEventName, (payload) => this.broadcast({ type: "event", node: tag, event, payload })),
        );
      }
    };
    forwardFrom(this.nodeA, "A");
    forwardFrom(this.nodeB, "B");

    // When B drops the entity, surface the resulting clipboard text for its tile.
    this.unsubscribes.push(
      this.nodeB.on("transfer:completed", () => {
        void this.clipB.readText().then((text) =>
          this.broadcast({ type: "event", node: "B", event: "clipboard:updated", payload: { text } }),
        );
      }),
    );
  }

  private broadcast(message: BridgeOutbound): void {
    let data: string;
    try {
      data = JSON.stringify(message);
    } catch {
      return; // non-serializable payload — skip rather than crash the relay
    }
    for (const client of this.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(data);
    }
  }

  private listen(): Promise<{ url: string; port: number }> {
    const server = http.createServer((req, res) => void this.serveStatic(req, res));
    this.httpServer = server;
    this.wss = new WebSocketServer({ server });
    this.wss.on("connection", (ws) => this.onClient(ws));

    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.options.port ?? 0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : (this.options.port ?? 0);
        resolve({ url: `http://localhost:${port}`, port });
      });
    });
  }

  private onClient(ws: WebSocket): void {
    this.clients.add(ws);
    const init: BridgeOutbound = {
      type: "init",
      nodes: [
        { tag: "A", id: this.nodeA.identityInfo.id, name: this.nodeA.identityInfo.name },
        { tag: "B", id: this.nodeB.identityInfo.id, name: this.nodeB.identityInfo.name },
      ],
    };
    ws.send(JSON.stringify(init));

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (isBridgeInbound(msg) && msg.node === "A") {
        this.sourceA.pushResult(msg.result, msg.timestamp);
      }
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private async serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.resolve(this.webRoot, rel);
      // Prevent path traversal outside the web root.
      if (!filePath.startsWith(this.webRoot)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const data = await fs.readFile(filePath);
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  }

  private once<T>(node: AirShareNode, event: AirShareEventName): Promise<T> {
    return new Promise((resolve) => {
      const off = node.on(event, (p) => {
        off();
        resolve(p as T);
      });
    });
  }

  /** Push a landmark result into A's vision (tests bypass the browser). */
  pushLandmarks(result: Parameters<MediaPipeLandmarkSource["pushResult"]>[0], timestamp: number): void {
    this.sourceA.pushResult(result, timestamp);
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    for (const client of this.clients) client.close();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()));
    for (const s of this.systems) s.detach();
    this.systems.length = 0;
    await this.visionA.stop();
    await Promise.all([this.nodeA.stop(), this.nodeB.stop()]);
    await Promise.all(
      this.dataDirs.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
    this.dataDirs.length = 0;
  }
}
