/**
 * Air Share experience — browser client (thin).
 *
 * Owns only: the camera, MediaPipe hand tracking, and rendering. It streams raw
 * landmark results to the Node bridge and animates the real events the bridge
 * relays back (grab, target, release, transfer). All mesh/crypto/transfer logic
 * lives in Node — this file draws what the real system is doing.
 */

import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";

type NodeTag = "A" | "B";
interface EventMsg { type: "event"; node: NodeTag; event: string; payload: any }
interface InitMsg { type: "init"; nodes: { tag: NodeTag; id: string; name: string }[] }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("cam");
const overlay = $<HTMLCanvasElement>("overlay");
const ctx = overlay.getContext("2d")!;
const objectEl = $("object");
const tileB = $("panel-B");
const statusEl = $("status");
const beam = $("beam");

// Fingertip + skeleton connections (MediaPipe hand topology).
const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

interface Vec { x: number; y: number }
let latestLandmarks: { x: number; y: number; z: number }[] | null = null;
let holding = false;
let deviceIds: Record<NodeTag, string> = { A: "", B: "" };

// ---- WebSocket to the bridge ----------------------------------------------

const ws = new WebSocket(`ws://${location.host}`);
ws.addEventListener("open", () => setStatus("live · mesh connected", true));
ws.addEventListener("close", () => setStatus("disconnected"));
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data as string) as EventMsg | InitMsg;
  if (msg.type === "init") return onInit(msg);
  if (msg.type === "event") onEvent(msg);
});

function setStatus(text: string, live = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("live", live);
}

function onInit(msg: InitMsg): void {
  for (const n of msg.nodes) {
    deviceIds[n.tag] = n.id;
    const el = document.getElementById(`name-${n.tag}`);
    if (el) el.textContent = n.name;
  }
}

function onEvent(msg: EventMsg): void {
  const p = msg.payload ?? {};
  switch (msg.event) {
    case "gesture:confidence":
      setHud("hud-gesture", p.type ?? "—");
      setHud("hud-conf", p.confidence != null ? `${Math.round(p.confidence * 100)}%` : "—");
      break;
    case "hand:grab":
      holding = true;
      setHud("hud-hold", "yes");
      objectEl.classList.add("show");
      break;
    case "hand:target-changed":
      setHud("hud-target", p.targetDeviceId === deviceIds.B ? "PC-B" : "—");
      tileB.classList.toggle("targeted", p.targetDeviceId === deviceIds.B);
      break;
    case "hand:release":
      holding = false;
      setHud("hud-hold", "no");
      flyToTarget();
      break;
    case "transfer:started":
      fireBeam();
      break;
    case "transfer:completed":
      if (msg.node === "B") tileB.classList.add("received");
      break;
    case "clipboard:updated":
      $("clip-B").textContent = p.text ?? "—";
      tileB.classList.remove("targeted");
      setTimeout(() => tileB.classList.remove("received"), 600);
      break;
    case "gesture:hand-lost":
      holding = false;
      setHud("hud-hold", "no");
      objectEl.classList.remove("show");
      break;
  }
}

function setHud(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ---- Camera + MediaPipe ----------------------------------------------------

async function startVision(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720 }, audio: false });
  video.srcObject = stream;
  await video.play();

  const fileset = await FilesetResolver.forVisionTasks("./vendor");
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "./vendor/hand_landmarker.task" },
    numHands: 1,
    runningMode: "VIDEO",
  });

  const loop = (): void => {
    if (video.readyState >= 2) {
      const result: HandLandmarkerResult = landmarker.detectForVideo(video, performance.now());
      handleResult(result);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function handleResult(result: HandLandmarkerResult): void {
  const hand = result.landmarks?.[0];
  latestLandmarks = hand ? hand.map((l) => ({ x: l.x, y: l.y, z: l.z ?? 0 })) : null;

  // Stream to the bridge (it runs the real VisionEngine + transfer runtime).
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "landmarks",
      node: "A",
      result: {
        landmarks: result.landmarks ?? [],
        handedness: (result.handedness ?? []).map((h) => h.map((c) => ({ categoryName: c.categoryName, score: c.score }))),
      },
      timestamp: performance.now(),
    }));
  }
  draw();
}

// ---- Rendering -------------------------------------------------------------

/** Map a normalised landmark (mirrored selfie view) to page coordinates. */
function toScreen(l: Vec): Vec {
  const r = video.getBoundingClientRect();
  return { x: r.left + (1 - l.x) * r.width, y: r.top + l.y * r.height };
}

function draw(): void {
  const r = video.getBoundingClientRect();
  overlay.width = r.width;
  overlay.height = r.height;
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const hand = latestLandmarks;
  if (hand) {
    ctx.save();
    ctx.scale(-1, 1); // mirror to match the selfie video
    ctx.translate(-overlay.width, 0);
    ctx.strokeStyle = "rgba(79,209,255,0.7)";
    ctx.lineWidth = 3;
    for (const [a, b] of CONNECTIONS) {
      const pa = hand[a], pb = hand[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x * overlay.width, pa.y * overlay.height);
      ctx.lineTo(pb.x * overlay.width, pb.y * overlay.height);
      ctx.stroke();
    }
    ctx.fillStyle = "#4fd1ff";
    for (const p of hand) {
      ctx.beginPath();
      ctx.arc(p.x * overlay.width, p.y * overlay.height, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // The floating object follows the pinch midpoint (thumb tip 4 ↔ index tip 8).
  if (holding && hand && hand[4] && hand[8]) {
    const mid = { x: (hand[4].x + hand[8].x) / 2, y: (hand[4].y + hand[8].y) / 2 };
    const s = toScreen(mid);
    objectEl.style.left = `${s.x}px`;
    objectEl.style.top = `${s.y}px`;
    objectEl.style.transform = "translate(-50%, -50%) scale(1)";
  }
}

// ---- Transfer animation ----------------------------------------------------

function fireBeam(): void {
  beam.classList.remove("fire");
  void beam.offsetWidth; // reflow to restart the animation
  beam.classList.add("fire");
}

/** Animate the object flying from the hand to the PC-B tile on release. */
function flyToTarget(): void {
  const startRect = objectEl.getBoundingClientRect();
  const target = tileB.querySelector(".device")!.getBoundingClientRect();
  const from = { x: startRect.left + startRect.width / 2, y: startRect.top + startRect.height / 2 };
  const to = { x: target.left + target.width / 2, y: target.top + target.height / 2 };

  const t0 = performance.now();
  const dur = 650;
  const step = (now: number): void => {
    const k = Math.min(1, (now - t0) / dur);
    const ease = 1 - Math.pow(1 - k, 3);
    objectEl.style.left = `${from.x + (to.x - from.x) * ease}px`;
    objectEl.style.top = `${from.y + (to.y - from.y) * ease}px`;
    objectEl.style.transform = `translate(-50%, -50%) scale(${1 - 0.4 * ease})`;
    if (k < 1) requestAnimationFrame(step);
    else objectEl.classList.remove("show");
  };
  requestAnimationFrame(step);
}

startVision().catch((err) => {
  console.error(err);
  setStatus("camera/model error — see console");
});
