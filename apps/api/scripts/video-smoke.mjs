process.env.VIDEO_WORKER_MODE = "worker";
process.env.VIDEO_POST_ENABLED = "true";
process.env.VIDEO_PREVIEW_WIDTH = process.env.VIDEO_PREVIEW_WIDTH || "270";
process.env.VIDEO_PREVIEW_HEIGHT = process.env.VIDEO_PREVIEW_HEIGHT || "480";
process.env.AUTONOMOUS_VIDEO_PLANNING = "false";

import { readFile } from "node:fs/promises";
const { validateBrief } = await import("../src/brief.js");
const { storeMedia } = await import("../src/media-store.js");
const { createVideoJob, waitForVideoJob } = await import("../src/video-orchestrator.js");
const { approveVideoJob } = await import("../src/video-approvals.js");
const { getVideoWorkerHealth } = await import("../src/video-worker-client.js");
const sharp = (await import("sharp")).default;

const health = await getVideoWorkerHealth();
if (!health.capabilities?.deterministicCompose) throw new Error("The local video worker cannot compose media.");

const suppliedProductPath = process.env.SMOKE_PRODUCT_IMAGE;
const product = await storeMedia({
  bytes: suppliedProductPath
    ? await readFile(suppliedProductPath)
    : await sharp({ create: { width: 600, height: 800, channels: 3, background: "#6f3d2d" } }).png().toBuffer(),
  mimeType: suppliedProductPath?.toLowerCase().endsWith(".jpg") || suppliedProductPath?.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png",
  filename: suppliedProductPath ? suppliedProductPath.split(/[\\/]/).at(-1) : "smoke-product.png",
  kind: "PRIMARY_PRODUCT"
});
const brief = validateBrief({
  product: "Atelier One",
  brand: "Northstar",
  category: "premium technology",
  colorway: "obsidian and copper",
  features: ["Precision body", "Quiet performance", "All-day balance"],
  tone: "minimal, cinematic, precise",
  callToAction: "Meet Atelier One"
});
const durationSeconds = Math.max(8, Math.min(60, Number(process.env.SMOKE_VIDEO_DURATION || 8)));
const fps = [24, 25, 30, 50, 60].includes(Number(process.env.SMOKE_VIDEO_FPS)) ? Number(process.env.SMOKE_VIDEO_FPS) : 24;
const queued = createVideoJob(brief, {
  durationSeconds,
  fps,
  useAi: false,
  productAssetIds: [product.id]
}, { merchantId: "local-smoke", conversationId: `smoke-${Date.now()}` });
const ready = await waitForVideoJob(queued.id, { timeoutMs: 7_200_000 });
if (ready.status !== "AWAITING_APPROVAL") throw new Error(ready.error || `Unexpected status ${ready.status}`);
const approved = await approveVideoJob(ready.id, { idempotencyKey: `smoke-${ready.id}`, deliver: false });
console.log(JSON.stringify({
  ok: true,
  jobId: ready.id,
  preview: ready.previewAssets.find(asset => asset.mimeType === "video/mp4"),
  probe: ready.qa.preview.probe,
  finalAssets: approved.finalAssets,
  workerCapabilities: health.capabilities
}, null, 2));
