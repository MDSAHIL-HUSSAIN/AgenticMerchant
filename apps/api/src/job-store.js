import { loadJobs, persistJob } from "./state-db.js";

const jobs = new Map(loadJobs().map(job => [job.id, job]));

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
