import { loadJobs, persistJob } from "./state-db.js";

const jobs = new Map(loadJobs().map(job => [job.id, job]));

const sensitiveKey = /(?:authorization|api[-_]?key|access[-_]?token|secret|password|signature)/i;

function safeLogValue(value, key = "") {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:access_token|api_key|key|signature)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 1000);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [childKey, safeLogValue(childValue, childKey)]));
  }
  return value;
}

function initialRevision(job) {
  if ((job.type || "IMAGE_POST") === "VIDEO_POST") {
    return {
      id: `revision_${crypto.randomUUID()}`,
      number: 1,
      source: "AUTONOMOUS_VIDEO_GENERATION",
      creativeTreatment: structuredClone(job.creativeTreatment || null),
      videoSpec: structuredClone(job.videoSpec || null),
      previewAssets: structuredClone(job.previewAssets || []),
      qa: structuredClone(job.qa || null),
      feedback: null,
      createdAt: job.createdAt || new Date().toISOString()
    };
  }
  return {
    id: `revision_${crypto.randomUUID()}`,
    number: 1,
    source: "AUTONOMOUS_GENERATION",
    designs: structuredClone(job.designs),
    previewAssets: structuredClone(job.previewAssets || []),
    qa: structuredClone(job.qa || null),
    feedback: null,
    createdAt: job.createdAt || new Date().toISOString()
  };
}

export function registerJob(rawJob, context = {}) {
  const existing = jobs.get(rawJob.id);
  if (existing) return existing;
  const revision = initialRevision(rawJob);
  const job = {
    ...rawJob,
    type: rawJob.type || "IMAGE_POST",
    merchantId: context.merchantId || rawJob.merchantId || "",
    conversationId: context.conversationId || rawJob.conversationId || "",
    productId: context.productId || rawJob.productId || "",
    productDraftId: context.productDraftId || rawJob.productDraftId || "",
    status: rawJob.status || "AWAITING_APPROVAL",
    currentRevisionId: revision.id,
    revisionNumber: 1,
    revisions: [revision],
    approvedDesignIds: [],
    finalAssets: [],
    handoffs: [],
    activityLogs: Array.isArray(rawJob.activityLogs) ? rawJob.activityLogs : [],
    processedKeys: [],
    updatedAt: new Date().toISOString()
  };
  jobs.set(job.id, job);
  persistJob(job);
  return job;
}

export function getJob(id) {
  const job = jobs.get(String(id));
  if (!job) throw new Error("Design job not found.");
  return job;
}

export function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  jobs.set(job.id, job);
  persistJob(job);
  return job;
}

export function appendJobLog(job, {
  stage = "WORKFLOW",
  status = "INFO",
  channel = "pipeline",
  message,
  details = null
} = {}) {
  if (!job || !message) return null;
  if (!Array.isArray(job.activityLogs)) job.activityLogs = [];
  const entry = {
    id: `log_${crypto.randomUUID()}`,
    sequence: job.activityLogs.length ? Number(job.activityLogs.at(-1).sequence || job.activityLogs.length) + 1 : 1,
    at: new Date().toISOString(),
    stage: String(stage),
    status: String(status).toUpperCase(),
    channel: String(channel),
    message: String(message).slice(0, 1000),
    ...(details ? { details: safeLogValue(details) } : {})
  };
  job.activityLogs.push(entry);
  if (job.activityLogs.length > 500) job.activityLogs.splice(0, job.activityLogs.length - 500);
  console.log(JSON.stringify({ event: "job.activity", jobId: job.id, ...entry }));
  saveJob(job);
  return entry;
}

export function listJobs({ type, statuses } = {}) {
  const allowed = statuses ? new Set(statuses) : null;
  return [...jobs.values()].filter(job => (!type || job.type === type) && (!allowed || allowed.has(job.status)));
}

export function hasProcessedKey(job, key) {
  return Boolean(key && job.processedKeys.includes(String(key)));
}

export function rememberProcessedKey(job, key) {
  if (!key || job.processedKeys.includes(String(key))) return;
  job.processedKeys.push(String(key));
  if (job.processedKeys.length > 100) job.processedKeys.splice(0, job.processedKeys.length - 100);
}

export function publicJob(job) {
  const clone = structuredClone(job);
  delete clone.processedKeys;
  return clone;
}
