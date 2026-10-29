import { EventEmitter } from "node:events";
import { validateBrief } from "./brief.js";
import { config } from "./config.js";
import { composeVideoPreview } from "./video-compositor.js";
import { getJob, listJobs, registerJob, saveJob } from "./job-store.js";
import { gpuTaskQueue } from "./task-queue.js";
import { createAutonomousVideoPlan, normalizeVideoPlan } from "./video-planner.js";
import { inspectVideoKeyframes, inspectVideoPlan, inspectVideoPreview } from "./video-quality.js";
import { renderVideoKeyframes } from "./video-renderer.js";
import { getMediaRecord } from "./media-store.js";

const events = new EventEmitter();
events.setMaxListeners(100);
const history = new Map();

function publish(job, stage, progress, message, extra = {}) {
  const event = { jobId: job.id, stage, progress, message, at: new Date().toISOString(), ...extra };
  const log = history.get(job.id) || [];
  log.push(event);
  if (log.length > 100) log.splice(0, log.length - 100);
  history.set(job.id, log);
  job.progress = event;
  saveJob(job);
  events.emit(job.id, event);
  return event;
}

function revisionFromJob(job, { source, feedback = null } = {}) {
  return {
    id: `revision_${crypto.randomUUID()}`,
    number: job.revisionNumber,
    source,
    creativeTreatment: structuredClone(job.creativeTreatment),
    videoSpec: structuredClone(job.videoSpec),
    previewAssets: structuredClone(job.previewAssets),
    qa: structuredClone(job.qa),
    feedback,
    createdAt: new Date().toISOString()
  };
}

async function executeVideoJob(job, { signal, planOverride, feedback, source = "AUTONOMOUS_VIDEO_GENERATION" } = {}) {
  try {
    job.status = "PLANNING";
    publish(job, "PLANNING", 5, "Selecting one autonomous creative treatment.");
    let planResult;
    if (planOverride) {
      planResult = { plan: normalizeVideoPlan(planOverride, job.brief, job.requestOptions), agentic: { planner: "revision", autonomous: true }, warnings: [] };
    } else {
      planResult = await createAutonomousVideoPlan(job.brief, job.requestOptions);
    }
    const planReview = inspectVideoPlan(planResult.plan);
    if (!planReview.passed) throw new Error(`Video plan failed validation: ${planReview.issues.map(issue => issue.code).join(", ")}`);
    job.creativeTreatment = { title: planResult.plan.title, concept: planResult.plan.concept, tone: planResult.plan.tone, palette: planResult.plan.palette, musicDirection: planResult.plan.musicDirection };
    job.videoSpec = planResult.plan;
    job.agentic = { ...job.agentic, ...planResult.agentic, planQa: planReview };
    job.warnings.push(...planResult.warnings);

    job.status = "GENERATING_KEYFRAMES";
    publish(job, "GENERATING_KEYFRAMES", 18, "Rendering controlled vertical keyframes.");
    const keyframes = await renderVideoKeyframes({ jobId: job.id, brief: job.brief, plan: job.videoSpec, productAssetIds: job.productAssetIds });
    job.keyframeAssets = keyframes;
    saveJob(job);
    const keyframeReview = await inspectVideoKeyframes(keyframes);
    if (!keyframeReview.passed) throw new Error(`Video keyframes failed creative QA: ${keyframeReview.issues.map(issue => issue.code).join(", ")}`);
    job.videoSpec.shots = job.videoSpec.shots.map((shot, index) => ({ ...shot, productAssetIds: [...job.productAssetIds], referenceAssetIds: [...job.referenceAssetIds], startKeyframeAssetId: keyframes[index]?.assetId, status: "KEYFRAME_READY" }));
    saveJob(job);

    job.status = "GENERATING_MOTION";
    publish(job, "GENERATING_MOTION", 42, "Generating and assembling the preview frame sequences.");
    const modelProgress = event => publish(job, event.stage, event.progress, event.message);
    let preview = await composeVideoPreview({ jobId: job.id, plan: job.videoSpec, keyframes, signal, onProgress: modelProgress });
    job.previewAssets = [preview.video, preview.poster];

    job.status = "RUNNING_TEMPORAL_QA";
    publish(job, "RUNNING_TEMPORAL_QA", 82, "Evaluating duration, frame output and delivery assets.");
    let previewReview = await inspectVideoPreview(preview.video.assetId, {
      durationSeconds: job.videoSpec.durationSeconds,
      width: config.videoPreviewWidth,
      height: config.videoPreviewHeight
    });
    let repairs = 0;
    if (!previewReview.passed && previewReview.issues.some(issue => issue.code === "RENDERED_DURATION_MISMATCH") && config.maxVideoJobRepairs > 0) {
      repairs += 1;
      publish(job, "REPAIRING_TIMELINE", 86, "Correcting the rendered timeline and rerunning temporal QA.");
      preview = await composeVideoPreview({ jobId: job.id, plan: job.videoSpec, keyframes, signal, onProgress: modelProgress });
      job.previewAssets = [preview.video, preview.poster];
      previewReview = await inspectVideoPreview(preview.video.assetId, {
        durationSeconds: job.videoSpec.durationSeconds,
        width: config.videoPreviewWidth,
        height: config.videoPreviewHeight
      });
    }
    job.qa = { passed: planReview.passed && keyframeReview.passed && previewReview.passed, score: Math.round((planReview.score + keyframeReview.score + previewReview.score) / 3), plan: planReview, keyframes: keyframeReview, preview: previewReview, repairs, issues: [...planReview.issues, ...keyframeReview.issues, ...previewReview.issues] };
    if (!job.qa.passed) throw new Error(`Video preview failed QA: ${job.qa.issues.map(issue => issue.code).join(", ")}`);

    job.status = "AWAITING_APPROVAL";
    publish(job, "AWAITING_APPROVAL", 100, "The autonomous video preview is ready for approval or revision.");
    if (source === "AUTONOMOUS_VIDEO_GENERATION" && job.revisions.length === 1 && !job.revisions[0].videoSpec) {
      job.revisions[0] = { ...revisionFromJob(job, { source, feedback }), id: job.currentRevisionId, number: 1 };
    } else {
      const revision = revisionFromJob(job, { source, feedback });
      job.currentRevisionId = revision.id;
      job.revisions.push(revision);
    }
    saveJob(job);
  } catch (error) {
    if (signal?.aborted) {
      job.status = "CANCELLED";
      publish(job, "CANCELLED", job.progress?.progress || 0, "Video generation was cancelled.");
    } else {
      job.status = "FAILED";
      job.error = error.message;
      publish(job, "FAILED", job.progress?.progress || 0, error.message);
    }
  }
}

function queueExecution(job, options = {}) {
  gpuTaskQueue.enqueue(job.id, context => executeVideoJob(job, { ...context, ...options }));
  return job;
}

export function createVideoJob(rawBrief, options = {}, context = {}) {
  const brief = validateBrief(rawBrief);
  const productAssetIds = [...(options.productAssetIds || [])];
  if (!productAssetIds.length && options.allowPlaceholder !== true) {
    throw new Error("A real product photo is required for video generation. Re-select the product image and confirm the draft reports at least 1 media file.");
  }
  if (options.allowPlaceholder !== true) {
    const invalid = productAssetIds.map(getMediaRecord).find(asset => !asset || !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType));
    if (invalid || productAssetIds.some(id => !getMediaRecord(id))) {
      throw new Error("Video generation requires a real raster product photo (PNG, JPEG, or WebP), not a test SVG or placeholder.");
    }
  }
  const id = crypto.randomUUID();
  const job = registerJob({
    id,
    type: "VIDEO_POST",
    status: "QUEUED",
    createdAt: new Date().toISOString(),
    brief,
    requestOptions: {
      durationSeconds: Number(options.durationSeconds) || undefined,
      aspectRatio: options.aspectRatio || "9:16",
      fps: Number(options.fps) || undefined,
      narrationEnabled: Boolean(options.narrationEnabled),
      useAi: options.useAi
    },
    productAssetIds,
    referenceAssetIds: [...(options.referenceAssetIds || [])],
    creativeTreatment: null,
    videoSpec: null,
    keyframeAssets: [],
    previewAssets: [],
    qa: null,
    agentic: { autonomous: true, productSource: productAssetIds.length ? "USER_ASSET" : "PLACEHOLDER" },
    warnings: [],
    progress: { stage: "QUEUED", progress: 0, message: "Waiting for the local GPU queue.", at: new Date().toISOString() }
  }, context);
  queueExecution(job);
  return job;
}

export function queueVideoRevision(jobId, { plan, feedback, source = "MERCHANT_FEEDBACK" }) {
  const job = getJob(jobId);
  if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  if (["FINALIZING", "READY_FOR_PUBLISHING"].includes(job.status)) throw new Error("The approved revision is locked.");
  job.revisionNumber += 1;
  job.status = "QUEUED";
  job.progress = { stage: "QUEUED", progress: 0, message: "Revision queued for autonomous regeneration.", at: new Date().toISOString() };
  saveJob(job);
  queueExecution(job, { planOverride: plan, feedback, source });
  return job;
}

export function retryVideoJob(jobId) {
  const job = getJob(jobId);
  if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  if (!["FAILED", "CANCELLED"].includes(job.status)) throw new Error("Only failed or cancelled video jobs can be retried.");
  job.status = "QUEUED";
  job.error = null;
  job.progress = { stage: "QUEUED", progress: 0, message: "Retry queued with the current validated treatment.", at: new Date().toISOString() };
  saveJob(job);
  queueExecution(job, job.videoSpec ? { planOverride: job.videoSpec, source: "RETRY" } : {});
  return job;
}

export function cancelVideoJob(jobId) {
  const job = getJob(jobId);
  if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  const cancelled = gpuTaskQueue.cancel(job.id);
  if (!cancelled && !["AWAITING_APPROVAL", "FAILED", "CANCELLED"].includes(job.status)) throw new Error("Video job is not queued or running.");
  if (cancelled && job.status === "QUEUED") {
    job.status = "CANCELLED";
    publish(job, "CANCELLED", 0, "Video generation was cancelled before starting.");
  }
  return job;
}

export function videoEvents(jobId) {
  return { history: [...(history.get(jobId) || [])], emitter: events };
}

export function recoverVideoJobs() {
  const recoverable = listJobs({ type: "VIDEO_POST", statuses: ["QUEUED", "PLANNING", "GENERATING_KEYFRAMES", "GENERATING_MOTION", "RUNNING_TEMPORAL_QA", "REVISING"] });
  for (const job of recoverable) {
    job.status = "QUEUED";
    job.warnings = [...(job.warnings || []), "Recovered unfinished video job after API restart."];
    saveJob(job);
    queueExecution(job, job.videoSpec ? { planOverride: job.videoSpec, source: "RECOVERY" } : {});
  }
  return recoverable.length;
}

export function waitForVideoJob(jobId, { timeoutMs = 10_000 } = {}) {
  const terminal = new Set(["AWAITING_APPROVAL", "READY_FOR_PUBLISHING", "FAILED", "CANCELLED"]);
  const existing = getJob(jobId);
  if (terminal.has(existing.status)) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.off(jobId, listener); reject(new Error("Timed out waiting for video job.")); }, timeoutMs);
    const listener = () => {
      const job = getJob(jobId);
      if (!terminal.has(job.status)) return;
      clearTimeout(timer);
      events.off(jobId, listener);
      resolve(job);
    };
    events.on(jobId, listener);
  });
}
