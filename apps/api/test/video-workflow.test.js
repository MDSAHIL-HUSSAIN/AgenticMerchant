import test from "node:test";
import assert from "node:assert/strict";
import { validateBrief } from "../src/brief.js";
import { approveVideoJob } from "../src/video-approvals.js";
import { createVideoJob, waitForVideoJob } from "../src/video-orchestrator.js";
import { applyVideoFeedback } from "../src/video-revisions.js";
import { storeMedia } from "../src/media-store.js";
import sharp from "sharp";

async function makeVideoJob() {
  const product = await storeMedia({
    bytes: await sharp({ create: { width: 600, height: 800, channels: 3, background: "#9f4528" } }).png().toBuffer(),
    mimeType: "image/png",
    filename: "product.png",
    kind: "PRIMARY_PRODUCT"
  });
  const brief = validateBrief({
    product: "Atelier Carry",
    brand: "Northstar",
    category: "premium accessories",
    colorway: "burnished copper",
    features: ["Precision-milled shell", "Soft-touch lining", "Balanced carry"],
    tone: "minimal, cinematic, precise",
    callToAction: "Meet Atelier Carry"
  });
  const queued = createVideoJob(brief, {
    durationSeconds: 60,
    aspectRatio: "9:16",
    fps: 30,
    useAi: false,
    productAssetIds: [product.id]
  }, { merchantId: "merchant-video", conversationId: `conversation-${crypto.randomUUID()}` });
  return waitForVideoJob(queued.id, { timeoutMs: 15_000 });
}

test("creates one autonomous exact-duration video preview with QA evidence", async () => {
  const job = await makeVideoJob();
  assert.equal(job.type, "VIDEO_POST");
  assert.equal(job.status, "AWAITING_APPROVAL");
  assert.equal(job.videoSpec.durationSeconds, 60);
  assert.equal(Math.round(job.videoSpec.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) * 10) / 10, 60);
  assert.equal(job.creativeTreatment !== null, true);
  assert.equal(job.qa.passed, true);
  assert.equal(job.previewAssets.some(asset => asset.mimeType === "video/mp4"), true);
  assert.equal(job.previewAssets.some(asset => asset.mimeType === "image/png"), true);
  assert.equal(job.keyframeAssets.length, job.videoSpec.shots.length);
  assert.equal(job.revisions.length, 1);
  assert.equal(job.revisions[0].source, "AUTONOMOUS_VIDEO_GENERATION");
});

test("refuses a placeholder slideshow when the product photo is missing", () => {
  assert.throws(() => createVideoJob(validateBrief({ product: "Missing product" }), {
    durationSeconds: 60,
    useAi: false,
    productAssetIds: []
  }), /real product photo is required/i);
});

test("keeps every shot duration positive for the shortest supported film", async () => {
  const { createDeterministicVideoPlan } = await import("../src/video-planner.js");
  const plan = createDeterministicVideoPlan(validateBrief({ product: "Mini", features: ["One"] }), { durationSeconds: 8, fps: 24 });
  assert.equal(Math.round(plan.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) * 10) / 10, 8);
  assert.equal(plan.shots.every(shot => shot.durationSeconds > 0), true);
});

test("revises only the requested video direction and preserves immutable history", async () => {
  const job = await makeVideoJob();
  const originalMotion = job.videoSpec.shots[2].motion;
  const queued = applyVideoFeedback(job.id, {
    feedback: "Make the hero reveal slower and calmer",
    shotIds: [job.videoSpec.shots[2].id],
    idempotencyKey: `video-edit-${job.id}`
  });
  const revised = await waitForVideoJob(queued.id, { timeoutMs: 15_000 });
  assert.equal(revised.status, "AWAITING_APPROVAL");
  assert.equal(revised.revisionNumber, 2);
  assert.equal(revised.revisions.length, 2);
  assert.equal(revised.revisions[0].videoSpec.shots[2].motion, originalMotion);
  assert.match(revised.videoSpec.shots[2].motion, /slower|calmer/i);
  assert.equal(revised.videoSpec.shots[0].motion, revised.revisions[0].videoSpec.shots[0].motion);
});

test("approval locks a video revision and creates platform variants", async () => {
  const job = await makeVideoJob();
  const approved = await approveVideoJob(job.id, { idempotencyKey: `video-approve-${job.id}`, deliver: false });
  assert.equal(approved.status, "READY_FOR_PUBLISHING");
  assert.deepEqual(new Set(approved.finalAssets.map(asset => asset.platform)), new Set([
    "video_master", "instagram_reel", "facebook_reel", "social_square", "social_portrait", "poster"
  ]));
  assert.equal(approved.finalAssets.filter(asset => asset.mimeType === "video/mp4").length, 5);
  assert.throws(() => applyVideoFeedback(job.id, { feedback: "change it" }), /locked/i);
});
