import cors from "cors";
import express from "express";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { config, providerStatus } from "./config.js";
import { validateBrief } from "./brief.js";
import { createDesignJob } from "./orchestrator.js";
import { normalizePlan } from "./planner.js";
import { critiqueGeminiDesigns } from "./providers.js";
import { addDraftMessage, answerClarification, draftToDesignInput, getDraft, submitDraft } from "./drafts.js";
import { createMediaReadStream, getMediaRecord, mediaFileInfo, readMedia } from "./media-store.js";
import { getJob, publicJob, registerJob, saveJob } from "./job-store.js";
import { applyFeedbackRevision, parseMultipartMetadata } from "./revisions.js";
import { approveDesigns } from "./approvals.js";
import { deliverPreviewPack, deliverPublishingAssets } from "./handoff.js";
import { attachAdobePage, claimAdobeJob, completeAdobeJob, createAdobeEditJob, getAdobeJob, listPendingAdobeJobs } from "./adobe-queue.js";
import { approveVideoJob } from "./video-approvals.js";
import { applyVideoFeedback } from "./video-revisions.js";
import { cancelVideoJob, createVideoJob, recoverVideoJobs, retryVideoJob, videoEvents } from "./video-orchestrator.js";
import { getVideoWorkerHealth } from "./video-worker-client.js";
import { processDashboardFeedback, processDashboardMessage, processWhatsAppFeedback, processWhatsAppMessage } from "./whatsapp-integration.js";
import { activityTrace, finishActivity, publishActivity } from "./activity-stream.js";

const app = express();
const imageCache = new Map();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 12, fileSize: 15 * 1024 * 1024, fields: 30, fieldSize: 2 * 1024 * 1024 }
});

function requireInternalService(request, response, next) {
  if (!config.internalServiceToken) {
    response.status(503).json({ error: "INTERNAL_SERVICE_TOKEN is not configured." });
    return;
  }
  const expected = `Bearer ${config.internalServiceToken}`;
  if (request.headers.authorization !== expected) {
    response.status(401).json({ error: "Unauthorized internal service request." });
    return;
  }
  next();
}
const enabled = value => value === true || value === 1 || /^(true|1|yes)$/i.test(String(value || ""));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "8mb" }));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
app.use((request, _response, next) => {
  console.log(`${new Date().toISOString()} ${request.method} ${request.path}`);
  next();
});

app.get("/health", (_request, response) => response.json({ ok: true, providers: providerStatus() }));
app.get("/api/video-worker/health", async (_request, response) => {
  try {
    response.json(await getVideoWorkerHealth());
  } catch (error) {
    response.status(503).json({ ok: false, error: error.message || "Video worker is unavailable." });
  }
});

app.post("/api/jobs", async (request, response) => {
  try {
    const job = registerJob(await createDesignJob(request.body));
    response.status(201).json(publicJob(job));
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to create the design pack." });
  }
});

app.get("/api/jobs/:id", (request, response) => {
  try {
    response.json(publicJob(getJob(request.params.id)));
  } catch (error) {
    response.status(404).json({ error: error.message });
  }
});

app.post("/api/product-drafts/messages", upload.any(), async (request, response) => {
  try {
    const draft = await addDraftMessage({ metadata: request.body.metadata || request.body, text: request.body.text, files: request.files || [] });
    response.status(201).json(draft);
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to process the product message." });
  }
});

app.post("/api/integrations/whatsapp/messages", requireInternalService, upload.any(), async (request, response) => {
  try {
    const metadata = parseMultipartMetadata(request.body);
    const result = await processWhatsAppMessage({ metadata, text: request.body.text || metadata.text, files: request.files || [] });
    response.status(result.reused ? 200 : 201).json(result);
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to process the WhatsApp product message." });
  }
});

app.post("/api/integrations/whatsapp/jobs/:id/feedback", requireInternalService, upload.any(), async (request, response) => {
  try {
    const payload = parseMultipartMetadata(request.body);
    const result = await processWhatsAppFeedback(request.params.id, payload, request.files || []);
    response.status(result.reused ? 200 : 201).json(result);
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to process WhatsApp feedback." });
  }
});

app.post("/api/integrations/dashboard/messages", requireInternalService, upload.any(), async (request, response) => {
  try {
    const metadata = { ...parseMultipartMetadata(request.body), sourceChannel: "dashboard" };
    const result = await processDashboardMessage({ metadata, text: request.body.text || metadata.text, files: request.files || [] });
    response.status(result.reused ? 200 : 201).json(result);
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to process the dashboard product message." });
  }
});

app.post("/api/integrations/dashboard/jobs/:id/feedback", requireInternalService, upload.any(), async (request, response) => {
  try {
    const payload = parseMultipartMetadata(request.body);
    const result = await processDashboardFeedback(request.params.id, payload, request.files || []);
    response.status(result.reused ? 200 : 201).json(result);
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to process dashboard feedback." });
  }
});

app.get("/api/product-drafts/:id", (request, response) => {
  try {
    response.json(getDraft(request.params.id));
  } catch (error) {
    response.status(404).json({ error: error.message });
  }
});

app.post("/api/product-drafts/:id/clarifications", (request, response) => {
  try {
    response.json(answerClarification(request.params.id, request.body));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/product-drafts/:id/submit", (request, response) => {
  try {
    response.json(submitDraft(request.params.id));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/product-drafts/:id/design", async (request, response) => {
  const traceId = String(request.headers["x-activity-trace"] || "").slice(0, 120);
  try {
    const input = draftToDesignInput(request.params.id);
    const job = registerJob(
      await createDesignJob(input.brief, { productAssetIds: input.productAssetIds, referenceAssetIds: input.referenceAssetIds, onActivity: entry => publishActivity(traceId, entry) }),
      {
        merchantId: input.draft.merchantId,
        conversationId: input.draft.conversationId,
        productId: input.draft.productId,
        productDraftId: request.params.id
      }
    );
    response.status(201).json(publicJob(job));
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to generate designs from this product draft." });
  } finally {
    finishActivity(traceId);
  }
});

app.get("/api/activity/:traceId/events", (request, response) => {
  const traceId = String(request.params.traceId || "").slice(0, 120);
  response.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  response.flushHeaders();
  const { history, emitter } = activityTrace(traceId);
  for (const entry of history) response.write(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`);
  const listener = entry => response.write(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`);
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  emitter.on(traceId, listener);
  request.on("close", () => { clearInterval(heartbeat); emitter.off(traceId, listener); });
});

app.post("/api/product-drafts/:id/video", async (request, response) => {
  try {
    if (!config.videoPostEnabled) throw new Error("Video posts are disabled. Set VIDEO_POST_ENABLED=true after configuring the local worker.");
    const input = draftToDesignInput(request.params.id);
    const job = createVideoJob(input.brief, {
      ...request.body,
      productAssetIds: input.productAssetIds,
      referenceAssetIds: input.referenceAssetIds
    }, {
      merchantId: input.draft.merchantId,
      conversationId: input.draft.conversationId,
      productId: input.draft.productId,
      productDraftId: request.params.id
    });
    response.status(202).json(publicJob(job));
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to queue the autonomous video post." });
  }
});

app.get("/api/video-jobs/:id", (request, response) => {
  try {
    const job = getJob(request.params.id);
    if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
    response.json(publicJob(job));
  } catch (error) {
    response.status(404).json({ error: error.message });
  }
});

app.get("/api/video-jobs/:id/events", (request, response) => {
  let job;
  try {
    job = getJob(request.params.id);
    if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  } catch (error) {
    response.status(404).json({ error: error.message });
    return;
  }
  response.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  response.flushHeaders();
  const { history, emitter } = videoEvents(job.id);
  for (const event of history) response.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
  const listener = event => response.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  emitter.on(job.id, listener);
  request.on("close", () => { clearInterval(heartbeat); emitter.off(job.id, listener); });
});

app.post("/api/video-jobs/:id/feedback", (request, response) => {
  try {
    response.status(202).json(publicJob(applyVideoFeedback(request.params.id, request.body)));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/video-jobs/:id/approve", async (request, response) => {
  try {
    response.json(publicJob(await approveVideoJob(request.params.id, {
      idempotencyKey: request.body.idempotencyKey || request.headers["idempotency-key"],
      deliver: request.body.deliver === undefined ? true : enabled(request.body.deliver)
    })));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/video-jobs/:id/cancel", (request, response) => {
  try { response.json(publicJob(cancelVideoJob(request.params.id))); }
  catch (error) { response.status(400).json({ error: error.message }); }
});

app.post("/api/video-jobs/:id/retry", (request, response) => {
  try { response.status(202).json(publicJob(retryVideoJob(request.params.id))); }
  catch (error) { response.status(400).json({ error: error.message }); }
});

app.post("/api/jobs/:id/deliver-preview", async (request, response) => {
  try {
    const job = getJob(request.params.id);
    const existing = job.handoffs.find(item => item.type === "WHATSAPP_PREVIEW" && item.revisionId === job.currentRevisionId && item.status === "DELIVERED");
    if (existing) {
      response.json({ result: { ...existing, reused: true }, job: publicJob(job) });
      return;
    }
    const result = await deliverPreviewPack(job);
    job.handoffs.push({ type: "WHATSAPP_PREVIEW", revisionId: job.currentRevisionId, ...result });
    saveJob(job);
    response.json({ result, job: publicJob(job) });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/feedback", upload.any(), async (request, response) => {
  try {
    const existingJob = getJob(request.params.id);
    const payload = parseMultipartMetadata(request.body);
    const action = String(payload.action || "EDIT_SELECTED").toUpperCase();
    if (existingJob.type === "VIDEO_POST") {
      if (action === "APPROVE_ALL" || action === "APPROVE_SELECTED") {
        response.json(publicJob(await approveVideoJob(existingJob.id, { idempotencyKey: payload.idempotencyKey || payload.messageId, deliver: payload.deliver === undefined ? true : enabled(payload.deliver) })));
      } else {
        response.status(202).json(publicJob(applyVideoFeedback(existingJob.id, payload)));
      }
      return;
    }
    if (action === "APPROVE_ALL" || action === "APPROVE_SELECTED") {
      const designIds = action === "APPROVE_ALL" ? [] : (Array.isArray(payload.designIds) ? payload.designIds : String(payload.designIds || "").split(",").filter(Boolean));
      const job = await approveDesigns(request.params.id, {
        designIds,
        idempotencyKey: payload.idempotencyKey || payload.messageId,
        deliver: payload.deliver === undefined ? true : enabled(payload.deliver)
      });
      response.json(publicJob(job));
      return;
    }
    if (action === "EDIT_MANUALLY") {
      const designIds = Array.isArray(payload.designIds) ? payload.designIds : String(payload.designIds || "").split(",").filter(Boolean);
      response.status(202).json(createAdobeEditJob(request.params.id, { designId: designIds[0], requestedBy: payload.requestedBy || "merchant" }));
      return;
    }
    const job = await applyFeedbackRevision(request.params.id, payload, request.files || []);
    response.status(201).json(publicJob(job));
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to process design feedback." });
  }
});

app.post("/api/jobs/:id/approve", async (request, response) => {
  try {
    const existingJob = getJob(request.params.id);
    if (existingJob.type === "VIDEO_POST") {
      response.json(publicJob(await approveVideoJob(existingJob.id, { idempotencyKey: request.body.idempotencyKey || request.headers["idempotency-key"], deliver: request.body.deliver === undefined ? true : enabled(request.body.deliver) })));
      return;
    }
    const job = await approveDesigns(request.params.id, {
      designIds: request.body.designIds,
      idempotencyKey: request.body.idempotencyKey || request.headers["idempotency-key"],
      deliver: request.body.deliver === undefined ? true : enabled(request.body.deliver)
    });
    response.json(publicJob(job));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/deliver-final", async (request, response) => {
  try {
    const job = getJob(request.params.id);
    if (job.status !== "READY_FOR_PUBLISHING") throw new Error("Approve and export the designs before publishing handoff.");
    const existing = job.handoffs.find(item => item.type === "PUBLISHING" && item.revisionId === job.currentRevisionId && item.status === "DELIVERED");
    if (existing) {
      response.json({ result: { ...existing, reused: true }, job: publicJob(job) });
      return;
    }
    const result = await deliverPublishingAssets(job);
    job.handoffs.push({ type: "PUBLISHING", revisionId: job.currentRevisionId, ...result });
    saveJob(job);
    response.json({ result, job: publicJob(job) });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/adobe-edit", (request, response) => {
  try {
    response.status(202).json(createAdobeEditJob(request.params.id, request.body));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.get("/api/adobe/jobs/pending", (_request, response) => response.json({ jobs: listPendingAdobeJobs() }));

app.get("/api/adobe/jobs/:id/specification", (request, response) => {
  try {
    response.json(getAdobeJob(request.params.id));
  } catch (error) {
    response.status(404).json({ error: error.message });
  }
});

app.post("/api/adobe/jobs/:id/claim", (request, response) => {
  try {
    response.json(claimAdobeJob(request.params.id));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/adobe/jobs/:id/page", (request, response) => {
  try {
    response.json(attachAdobePage(request.params.id, request.body.adobePageId));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/api/adobe/jobs/:id/result", upload.single("rendition"), async (request, response) => {
  try {
    const metadata = parseMultipartMetadata(request.body);
    const result = await completeAdobeJob(request.params.id, request.file, metadata);
    response.status(201).json({ adobeJob: result.adobeJob, designJob: publicJob(result.designJob) });
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to save the Adobe revision." });
  }
});

app.get("/api/assets/:id", (request, response) => {
  const asset = getMediaRecord(request.params.id);
  if (!asset) return response.status(404).json({ error: "Asset not found." });
  response.json(asset);
});

app.get("/api/assets/:id/content", async (request, response) => {
  try {
    const { record, size } = await mediaFileInfo(request.params.id);
    const range = request.headers.range;
    const baseHeaders = {
      "content-type": record.mimeType,
      "content-disposition": `inline; filename="${record.filename.replaceAll('"', "")}"`,
      "cache-control": "private, max-age=3600",
      "accept-ranges": "bytes"
    };
    if (range) {
      const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return response.status(416).set("content-range", `bytes */${size}`).end();
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= size) return response.status(416).set("content-range", `bytes */${size}`).end();
      response.status(206).set({ ...baseHeaders, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` });
      createMediaReadStream(request.params.id, { start, end }).pipe(response);
      return;
    }
    response.set({ ...baseHeaders, "content-length": String(size) });
    createMediaReadStream(request.params.id).pipe(response);
  } catch (error) {
    response.status(404).json({ error: error.message });
  }
});

app.post("/api/critique", async (request, response) => {
  try {
    const brief = validateBrief(request.body?.brief);
    const designs = normalizePlan({ designs: request.body?.designs }, brief, 3);
    const review = await critiqueGeminiDesigns({ brief, designs, previews: request.body?.previews });
    if (!review) throw new Error("Visual review is unavailable without a live Gemini key.");
    response.json({
      summary: String(review.summary || "Visual review completed."),
      scores: review.scores || {},
      designs: normalizePlan(review, brief, 3)
    });
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: error.message || "Unable to critique the design previews." });
  }
});

app.get("/api/demo-image/:index.svg", (request, response) => {
  const index = Math.max(0, Math.min(2, Number.parseInt(request.params.index, 10) || 0));
  const label = String(request.query.label || "PRODUCT").slice(0, 70).replace(/[<>&\"']/g, "");
  const rotations = [-12, 5, 16];
  const colors = ["#B9FF38", "#48D9FF", "#FF8BB6"];
  response.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200"><rect width="1200" height="1200" fill="#f5f2ea"/><g transform="translate(600 570) rotate(${rotations[index]})"><ellipse cy="265" rx="390" ry="48" fill="#000" opacity=".14"/><path d="M-390 60 C-250-80-110-190 55-205 C190-215 290-120 365 10 C405 80 390 145 300 165 L-245 215 C-360 225-430 150-390 60Z" fill="#151517"/><path d="M-280 15 C-110-55 10-130 160-108 C220-98 275-58 320 10 L-255 82Z" fill="${colors[index]}"/><path d="M-360 125 L340 65 C405 60 410 150 325 170 L-270 220 C-350 225-400 190-360 125Z" fill="#fff"/><path d="M-70-135 L15 70 M35-160 L115 55" stroke="#fff" stroke-width="18" opacity=".8"/></g><text x="60" y="1080" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#151517">${label}</text><text x="60" y="1125" font-family="Arial, sans-serif" font-size="20" fill="#777">DEMO ASSET · ANGLE ${index + 1}</text></svg>`);
});

app.get("/api/image", async (request, response) => {
  try {
    const url = new URL(String(request.query.url || ""));
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only HTTP(S) image URLs are supported.");
    if (/^(localhost|127\.|0\.0\.0\.0|::1)/i.test(url.hostname)) throw new Error("Local targets are blocked.");
    const cached = imageCache.get(url.href);
    if (cached && cached.expiresAt > Date.now()) {
      response.set({ "content-type": cached.contentType, "cache-control": "public, max-age=86400" }).send(cached.bytes);
      return;
    }
    const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "DesignAgentPrototype/0.1" } });
    if (!upstream.ok) throw new Error(`Upstream returned ${upstream.status}`);
    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) throw new Error("The selected URL did not return an image.");
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("Image exceeds the 12 MB prototype limit.");
    if (imageCache.size >= 50) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(url.href, { bytes, contentType, expiresAt: Date.now() + 86_400_000 });
    response.set({ "content-type": contentType, "cache-control": "public, max-age=86400" }).send(bytes);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

const recoveredVideoJobs = config.videoPostEnabled ? recoverVideoJobs() : 0;
app.listen(config.port, () => console.log(`Design Agent API running at http://localhost:${config.port} (${config.demoMode ? "demo" : "live"} mode)${recoveredVideoJobs ? `; recovered ${recoveredVideoJobs} video job(s)` : ""}`));
