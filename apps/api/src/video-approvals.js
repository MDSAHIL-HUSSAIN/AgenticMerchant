import { deliverPublishingAssets } from "./handoff.js";
import { getJob, hasProcessedKey, rememberProcessedKey, saveJob } from "./job-store.js";
import { createVideoFinalExports } from "./video-exports.js";

export async function approveVideoJob(jobId, { idempotencyKey = "", deliver = true } = {}) {
  const job = getJob(jobId);
  if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  if (hasProcessedKey(job, idempotencyKey)) return job;
  if (job.status === "READY_FOR_PUBLISHING" && job.finalAssets.length) return job;
  if (job.status !== "AWAITING_APPROVAL") throw new Error("The video preview is not ready for approval.");
  job.status = "FINALIZING";
  saveJob(job);
  try {
    job.finalAssets = await createVideoFinalExports(job);
    job.approvedDesignIds = ["video_master"];
    job.status = "READY_FOR_PUBLISHING";
    if (deliver) {
      const result = await deliverPublishingAssets(job);
      job.handoffs.push({ type: "PUBLISHING", revisionId: job.currentRevisionId, ...result });
    }
    rememberProcessedKey(job, idempotencyKey);
    return saveJob(job);
  } catch (error) {
    job.status = "AWAITING_APPROVAL";
    job.finalAssets = [];
    saveJob(job);
    throw error;
  }
}
