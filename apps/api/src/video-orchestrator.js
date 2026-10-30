import { EventEmitter } from "node:events";
import { validateBrief } from "./brief.js";
import { config } from "./config.js";
import { composeVideoPreview } from "./video-compositor.js";
import { appendJobLog, getJob, listJobs, registerJob, saveJob } from "./job-store.js";
import { gpuTaskQueue } from "./task-queue.js";
import { createAutonomousVideoPlan, normalizeVideoPlan } from "./video-planner.js";
import { inspectVideoKeyframes, inspectVideoPlan, inspectVideoPreview } from "./video-quality.js";
import { renderVideoKeyframes } from "./video-renderer.js";
import { getMediaRecord, storeMedia } from "./media-store.js";
import { inspectVideoVisuals } from "./video-visual-review.js";
import { applyTargetedVideoRepairs } from "./video-timeline.js";

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
  appendJobLog(job, {
    stage,
    status: stage === "FAILED" ? "FAILED" : stage === "CANCELLED" ? "CANCELLED" : stage === "AWAITING_APPROVAL" ? "SUCCESS" : /FALLBACK|REPAIR/.test(stage) ? "WARNING" : "RUNNING",
    channel: "video",
    message,
    details: { progress, ...extra }
  });
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
    productionArtifacts: structuredClone(job.productionArtifacts || []),
    editor: structuredClone(job.editor || null),
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
    job.previewAssets = [preview.video, preview.poster, ...(preview.timelineArtifact ? [preview.timelineArtifact] : [])];
    job.productionArtifacts = [...(job.productionArtifacts || []), ...(preview.timelineArtifact ? [preview.timelineArtifact] : [])];
    job.editor = preview.editorReport;
    if (preview.editorReport?.warning) job.warnings.push(`Remotion editor used FFmpeg fallback: ${preview.editorReport.warning}`);

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
      job.previewAssets = [preview.video, preview.poster, ...(preview.timelineArtifact ? [preview.timelineArtifact] : [])];
      job.productionArtifacts.push(...(preview.timelineArtifact ? [preview.timelineArtifact] : []));
      job.editor = preview.editorReport;
      previewReview = await inspectVideoPreview(preview.video.assetId, {
        durationSeconds: job.videoSpec.durationSeconds,
        width: config.videoPreviewWidth,
        height: config.videoPreviewHeight
      });
    }
    publish(job, "RUNNING_VISUAL_QA", 88, "Inspecting story frames, composition, product presence, typography and edit continuity.");
    let visualReview = await inspectVideoVisuals({ jobId: job.id, assetId: preview.video.assetId, plan: job.videoSpec, brief: job.brief, pass: 1 });
    if (visualReview.artifact) job.productionArtifacts.push(visualReview.artifact);
    if (visualReview.warning) job.warnings.push(visualReview.warning);
    const visualRepairHistory = [];
    let visualRepairs = 0;
    while (!visualReview.passed && visualRepairs < config.maxVideoVisualRepairs) {
      const targeted = applyTargetedVideoRepairs(job.videoSpec, visualReview.issues);
      if (!targeted.actions.length) break;
      visualRepairs += 1;
      repairs += 1;
      visualRepairHistory.push({ pass: visualRepairs, actions: targeted.actions, affectedShotIds: targeted.affectedShotIds });
      job.videoSpec = targeted.plan;
      publish(job, "REPAIRING_VISUAL_EDIT", 89 + visualRepairs, `Applying ${targeted.actions.length} targeted visual repair${targeted.actions.length === 1 ? "" : "s"} and rerendering affected compositions.`, { affectedShotIds: targeted.affectedShotIds });
      const repairedKeyframes = await renderVideoKeyframes({ jobId: job.id, brief: job.brief, plan: job.videoSpec, productAssetIds: job.productAssetIds, existingKeyframes: job.keyframeAssets, onlyShotIds: targeted.affectedShotIds });
      job.keyframeAssets = repairedKeyframes;
      job.videoSpec.shots = job.videoSpec.shots.map((shot, index) => ({ ...shot, productAssetIds: [...job.productAssetIds], referenceAssetIds: [...job.referenceAssetIds], startKeyframeAssetId: repairedKeyframes[index]?.assetId, status: "KEYFRAME_READY" }));
      preview = await composeVideoPreview({ jobId: job.id, plan: job.videoSpec, keyframes: repairedKeyframes, signal, onProgress: modelProgress });
      job.previewAssets = [preview.video, preview.poster, ...(preview.timelineArtifact ? [preview.timelineArtifact] : [])];
      job.productionArtifacts.push(...(preview.timelineArtifact ? [preview.timelineArtifact] : []));
      job.editor = preview.editorReport;
      previewReview = await inspectVideoPreview(preview.video.assetId, { durationSeconds: job.videoSpec.durationSeconds, width: config.videoPreviewWidth, height: config.videoPreviewHeight });
      visualReview = await inspectVideoVisuals({ jobId: job.id, assetId: preview.video.assetId, plan: job.videoSpec, brief: job.brief, pass: visualRepairs + 1 });
      if (visualReview.artifact) job.productionArtifacts.push(visualReview.artifact);
      if (visualReview.warning) job.warnings.push(visualReview.warning);
      saveJob(job);
    }
    const motionSelections = preview.workerReport?.motionSelections || [];
    const expectedMotionSelections = config.videoFastTemplateMode
      ? 0
      : job.videoSpec.shots.filter(shot => shot.renderMode === "GENERATIVE").length;
    const motionIssues = config.videoWorkerMode === "mock" || motionSelections.length === expectedMotionSelections
      ? []
      : [{ severity: "high", code: "MISSING_GENERATIVE_MOTION_QA", expected: expectedMotionSelections, actual: motionSelections.length }];
    const motionReview = {
      passed: !motionIssues.length && motionSelections.every(selection => selection.accepted && selection.selectedMetrics?.passed),
      score: motionIssues.length ? 0 : 100,
      expected: expectedMotionSelections,
      selections: motionSelections,
      issues: motionIssues
    };
    job.qa = { passed: planReview.passed && keyframeReview.passed && previewReview.passed && motionReview.passed && visualReview.passed, score: Math.round((planReview.score + keyframeReview.score + previewReview.score + motionReview.score + visualReview.score) / 5), plan: planReview, keyframes: keyframeReview, motion: motionReview, preview: previewReview, visual: visualReview, repairs, visualRepairHistory, issues: [...planReview.issues, ...keyframeReview.issues, ...motionReview.issues, ...previewReview.issues, ...visualReview.issues] };
    if (!job.qa.passed) throw new Error(`Video preview failed QA: ${job.qa.issues.map(issue => issue.code).join(", ")}`);

    const productionManifest = {
      schemaVersion: 2,
      jobId: job.id,
      revisionNumber: job.revisionNumber,
      createdAt: new Date().toISOString(),
      creativeTreatment: job.creativeTreatment,
      videoSpec: job.videoSpec,
      editor: job.editor,
      previewAssets: job.previewAssets,
      keyframeAssets: job.keyframeAssets,
      qa: job.qa,
      warnings: job.warnings
    };
    const productionAsset = await storeMedia({ bytes: Buffer.from(JSON.stringify(productionManifest, null, 2)), mimeType: "application/json", filename: `${job.id}-production-manifest.json`, kind: "VIDEO_PRODUCTION_MANIFEST", metadata: { videoJobId: job.id, revisionNumber: job.revisionNumber, schemaVersion: 2 } });
    job.productionArtifacts.push({ assetId: productionAsset.id, kind: productionAsset.kind, mimeType: productionAsset.mimeType });

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
      autonomousDuration: options.autonomousDuration !== false && !Number(options.durationSeconds),
      useAi: options.useAi
    },
    productAssetIds,
    referenceAssetIds: [...(options.referenceAssetIds || [])],
    creativeTreatment: null,
    videoSpec: null,
    keyframeAssets: [],
    previewAssets: [],
    productionArtifacts: [],
    editor: null,
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
