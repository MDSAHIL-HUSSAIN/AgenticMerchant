import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  claimGeminiVideoJob, getGeminiVideoJob, heartbeatGeminiVideoJob, insertGeminiVideoJob,
  listGeminiVideoJobs, saveGeminiVideoJob
} from "./gemini-video-store.js";
import { createVideoUploadTicket, verifyVideoObject } from "./gemini-video-storage.js";
import { publishGeminiVideo } from "./gemini-video-publishers.js";

const ACTIVE = new Set(["CLAIMED", "PLANNING", "GENERATING", "DOWNLOADING", "UPLOADING"]);
const clean = (value, max = 2000) => String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const now = () => new Date().toISOString();

function log(job, stage, message, details = null) {
  if (!Array.isArray(job.events)) job.events = [];
  job.events.push({ id: randomUUID(), at: now(), stage, message: clean(message, 500), ...(details ? { details } : {}) });
  if (job.events.length > 100) job.events.splice(0, job.events.length - 100);
}

function assertEnabled() {
  if (!config.geminiWebVideoEnabled) throw new Error("Gemini web video jobs are disabled. Set GEMINI_WEB_VIDEO_ENABLED=true.");
}

function publicJob(job) {
  if (!job) return null;
  const clone = structuredClone(job);
  delete clone.claimedBy;
  delete clone.leaseExpiresAt;
  delete clone.uploadTicket;
  return clone;
}

async function requiredJob(id) {
  const job = await getGeminiVideoJob(id);
  if (!job) throw Object.assign(new Error("Gemini video job not found."), { status: 404 });
  return job;
}

function assertWorker(job, workerId) {
  if (!ACTIVE.has(job.status)) throw new Error(`Job is not active; current status is ${job.status}.`);
  if (!workerId || job.claimedBy !== workerId) throw Object.assign(new Error("This job is leased to a different worker."), { status: 409 });
}

async function notifyDashboard(job) {
  if (job.sourceChannel !== "dashboard" || !config.dashboardHandoffUrl) return null;
  try {
    const response = await fetch(config.dashboardHandoffUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${config.internalServiceToken}`, "content-type": "application/json", "idempotency-key": `gemini-video:${job.id}:${job.generationAttempt}` },
      body: JSON.stringify({
        event: "video.preview_ready",
        merchantId: job.merchantId,
        videoJobId: job.id,
        status: job.status,
        video: job.video,
        caption: job.caption,
        targetChannels: job.targetChannels,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}.`);
    return { status: "DELIVERED", at: now() };
  } catch (error) {
    return { status: "FAILED", at: now(), error: clean(error.message, 300) };
  }
}

export async function createGeminiVideoJob(input = {}) {
  assertEnabled();
  const productName = clean(input.productName || input.product || input.brief?.product, 160);
  const instructions = clean(input.instructions || input.prompt || input.brief?.creativeDirection, 4000);
  if (!productName && !instructions) throw new Error("Provide a product name or video instructions.");
  const createdAt = now();
  const job = {
    id: `gvideo_${randomUUID()}`,
    type: "GEMINI_WEB_VIDEO",
    status: "QUEUED",
    merchantId: clean(input.merchantId || "merchant", 120),
    conversationId: clean(input.conversationId, 200),
    sourceChannel: clean(input.sourceChannel || "dashboard", 40),
    targetChannels: [...new Set((Array.isArray(input.targetChannels) ? input.targetChannels : ["instagram", "facebook"])
      .map(value => String(value).toLowerCase()).filter(value => ["instagram", "facebook"].includes(value)))],
    request: {
      productName,
      brand: clean(input.brand || input.brief?.brand, 120),
      category: clean(input.category || input.brief?.category, 120),
      offer: clean(input.offer, 500),
      couponCode: clean(input.couponCode, 80),
      callToAction: clean(input.callToAction, 300),
      instructions,
      productImageUrl: /^https:\/\//i.test(String(input.productImageUrl || "")) ? String(input.productImageUrl) : null,
      durationSeconds: Math.max(3, Math.min(10, Number(input.durationSeconds || 8))),
      aspectRatio: "9:16",
      caption: clean(input.caption, 2200)
    },
    caption: clean(input.caption || [productName, input.offer, input.callToAction].filter(Boolean).join(" — "), 2200),
    generationAttempt: 1,
    maxAttempts: Math.max(1, Math.min(5, Number(input.maxAttempts || 3))),
    progress: { percent: 0, message: "Waiting for the local Gemini worker." },
    video: null,
    publishing: null,
    approval: null,
    error: null,
    events: [],
    availableAt: createdAt,
    createdAt,
    updatedAt: createdAt
  };
  log(job, "QUEUED", "Gemini video request queued for the local worker.");
  return publicJob(await insertGeminiVideoJob(job));
}

export async function getPublicGeminiVideoJob(id) {
  return publicJob(await requiredJob(id));
}

export async function listPublicGeminiVideoJobs(options) {
  return (await listGeminiVideoJobs(options)).map(publicJob);
}

export async function claimNextGeminiVideoJob(workerId) {
  assertEnabled();
  const id = clean(workerId, 120);
  if (!id) throw new Error("workerId is required.");
  const job = await claimGeminiVideoJob(id, config.geminiVideoLeaseSeconds);
  if (!job) return null;
  log(job, "CLAIMED", `Job claimed by local worker ${id}.`);
  return saveGeminiVideoJob(job, { preserveLease: true });
}

export async function heartbeatGeminiVideo(id, workerId) {
  const job = await heartbeatGeminiVideoJob(id, clean(workerId, 120), config.geminiVideoLeaseSeconds);
  if (!job) throw Object.assign(new Error("The worker no longer owns this job."), { status: 409 });
  return { ok: true, leaseExpiresAt: job.leaseExpiresAt };
}

export async function updateGeminiVideoProgress(id, workerId, input = {}) {
  const job = await requiredJob(id);
  assertWorker(job, clean(workerId, 120));
  const allowed = new Set(["PLANNING", "GENERATING", "DOWNLOADING", "UPLOADING"]);
  const status = String(input.status || job.status).toUpperCase();
  if (!allowed.has(status)) throw new Error("Unsupported worker progress status.");
  job.status = status;
  job.progress = { percent: Math.max(0, Math.min(99, Number(input.percent || 0))), message: clean(input.message, 300) };
  if (input.creativePrompt) job.creativePrompt = clean(input.creativePrompt, 12000);
  log(job, status, job.progress.message || status);
  return publicJob(await saveGeminiVideoJob(job, { preserveLease: true }));
}

export async function issueGeminiVideoUploadTicket(id, workerId) {
  const job = await requiredJob(id);
  assertWorker(job, clean(workerId, 120));
  const ticket = await createVideoUploadTicket(job);
  job.status = "UPLOADING";
  job.progress = { percent: 90, message: "Uploading the original Gemini MP4 unchanged." };
  job.uploadTicket = { objectKey: ticket.objectKey, publicUrl: ticket.publicUrl, contentType: ticket.contentType, issuedAt: now() };
  log(job, "UPLOADING", "Issued a direct object-storage upload URL.");
  await saveGeminiVideoJob(job, { preserveLease: true });
  return ticket;
}

export async function completeGeminiVideoJob(id, workerId, input = {}) {
  const job = await requiredJob(id);
  assertWorker(job, clean(workerId, 120));
  if (!job.uploadTicket?.objectKey) throw new Error("Request an upload ticket before completing the job.");
  const sha256 = String(input.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("A valid SHA-256 checksum is required.");
  const byteLength = Number(input.byteLength || 0);
  if (!Number.isSafeInteger(byteLength) || byteLength < 1024 || byteLength > 1024 * 1024 * 1024) throw new Error("MP4 size is invalid or exceeds 1 GB.");
  const verified = await verifyVideoObject({ objectKey: job.uploadTicket.objectKey, expectedBytes: byteLength });
  job.video = {
    publicUrl: job.uploadTicket.publicUrl,
    objectKey: job.uploadTicket.objectKey,
    mimeType: "video/mp4",
    byteLength: verified.byteLength,
    sha256,
    durationSeconds: Number(input.durationSeconds || 0) || null,
    width: Number(input.width || 0) || null,
    height: Number(input.height || 0) || null,
    fps: Number(input.fps || 0) || null,
    originalFilename: clean(input.originalFilename || "gemini-video.mp4", 200),
    storageEtag: verified.etag,
    unchanged: true
  };
  job.status = "AWAITING_APPROVAL";
  job.progress = { percent: 100, message: "Original Gemini video is ready for merchant review." };
  job.claimedBy = null;
  job.leaseExpiresAt = null;
  job.error = null;
  delete job.uploadTicket;
  log(job, "AWAITING_APPROVAL", "Original Gemini MP4 verified and ready for approval.", { sha256, byteLength });
  let saved = await saveGeminiVideoJob(job);
  saved.dashboardHandoff = await notifyDashboard(saved);
  saved = await saveGeminiVideoJob(saved);
  return publicJob(saved);
}

export async function failGeminiVideoJob(id, workerId, input = {}) {
  const job = await requiredJob(id);
  assertWorker(job, clean(workerId, 120));
  job.error = clean(input.error || "Gemini web generation failed.", 1000);
  job.claimedBy = null;
  job.leaseExpiresAt = null;
  if (job.generationAttempt < job.maxAttempts && input.retryable !== false) {
    job.generationAttempt += 1;
    job.status = "RETRY";
    job.availableAt = new Date(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (job.generationAttempt - 2))).toISOString();
    job.progress = { percent: 0, message: "Waiting to retry Gemini generation." };
  } else {
    job.status = "FAILED";
  }
  log(job, job.status, job.error);
  return publicJob(await saveGeminiVideoJob(job));
}

export async function retryGeminiVideoJob(id) {
  const job = await requiredJob(id);
  if (!new Set(["FAILED", "REJECTED", "AWAITING_APPROVAL"]).has(job.status)) throw new Error("Only failed, rejected or review-ready jobs can be regenerated.");
  job.status = "QUEUED";
  job.generationAttempt += 1;
  job.availableAt = now();
  job.video = null;
  job.publishing = null;
  job.approval = null;
  job.error = null;
  job.progress = { percent: 0, message: "Regeneration queued." };
  log(job, "QUEUED", "Merchant requested a new Gemini generation.");
  return publicJob(await saveGeminiVideoJob(job));
}

export async function rejectGeminiVideoJob(id, reason = "") {
  const job = await requiredJob(id);
  if (job.status !== "AWAITING_APPROVAL") throw new Error("Only a review-ready video can be rejected.");
  job.status = "REJECTED";
  job.approval = { decision: "REJECTED", reason: clean(reason, 1000), at: now() };
  log(job, "REJECTED", job.approval.reason || "Merchant rejected the generated video.");
  return publicJob(await saveGeminiVideoJob(job));
}

export async function approveGeminiVideoJob(id, input = {}) {
  const job = await requiredJob(id);
  if (input.confirm !== true) throw new Error("Explicit merchant confirmation is required before publishing.");
  if (job.status !== "AWAITING_APPROVAL") throw new Error("This video is not awaiting approval.");
  job.status = "PUBLISHING";
  job.approval = { decision: "APPROVED", at: now(), approvedBy: clean(input.approvedBy || "merchant", 120) };
  log(job, "PUBLISHING", "Merchant approved the exact Gemini MP4 for publishing.");
  await saveGeminiVideoJob(job);
  const deliveries = await publishGeminiVideo(job);
  const delivered = deliveries.filter(item => item.status === "DELIVERED");
  const failed = deliveries.filter(item => item.status === "FAILED");
  job.publishing = { deliveries, completedAt: now() };
  job.status = failed.length ? (delivered.length ? "PARTIALLY_PUBLISHED" : "PUBLISH_FAILED") : (delivered.length ? "PUBLISHED" : "APPROVED");
  log(job, job.status, delivered.length ? `Published to ${delivered.map(item => item.channel).join(" and ")}.` : "Video approved; no configured Meta destination accepted it.");
  return publicJob(await saveGeminiVideoJob(job));
}
