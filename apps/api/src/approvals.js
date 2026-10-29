import { createFinalExports } from "./exports.js";
import { deliverPublishingAssets } from "./handoff.js";
import { getJob, hasProcessedKey, rememberProcessedKey, saveJob } from "./job-store.js";

export async function approveDesigns(jobId, { designIds = [], idempotencyKey = "", deliver = true } = {}) {
  const job = getJob(jobId);
  if (hasProcessedKey(job, idempotencyKey)) return job;
  if (job.status === "READY_FOR_PUBLISHING" && job.finalAssets.length) return job;
  const requested = Array.isArray(designIds) && designIds.length ? designIds : job.designs.map(design => design.id);
  const valid = new Set(job.designs.map(design => design.id));
  const selected = [...new Set(requested.map(String))].filter(id => valid.has(id));
  if (!selected.length) throw new Error("At least one valid design must be approved.");
  const previousStatus = job.status;
  job.status = "EXPORTING_FINAL_ASSETS";
  saveJob(job);
  try {
    job.approvedDesignIds = selected;
    job.finalAssets = await createFinalExports(job, selected);
    job.status = "READY_FOR_PUBLISHING";
    if (deliver) {
      const result = await deliverPublishingAssets(job);
      job.handoffs.push({ type: "PUBLISHING", revisionId: job.currentRevisionId, ...result });
    }
    rememberProcessedKey(job, idempotencyKey);
    return saveJob(job);
  } catch (error) {
    job.status = previousStatus;
    job.approvedDesignIds = [];
    job.finalAssets = [];
    saveJob(job);
    throw error;
  }
}
