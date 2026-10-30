import { deliverPublishingAssets } from "./handoff.js";
import { appendJobLog, getJob, hasProcessedKey, rememberProcessedKey, saveJob } from "./job-store.js";
import { createVideoFinalExports } from "./video-exports.js";

export async function approveVideoJob(jobId, { idempotencyKey = "", deliver = true } = {}) {
  const job = getJob(jobId);
  if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  if (hasProcessedKey(job, idempotencyKey)) return job;
  if (job.status === "READY_FOR_PUBLISHING" && job.finalAssets.length) return job;
  if (job.status !== "AWAITING_APPROVAL") throw new Error("The video preview is not ready for approval.");
  job.status = "FINALIZING";
  appendJobLog(job, { channel: "export", stage: "FINAL_VIDEO_EXPORT", status: "STARTED", message: "Creating the approved master video and social platform versions." });
  saveJob(job);
  try {
    job.finalAssets = await createVideoFinalExports(job);
    appendJobLog(job, { channel: "export", stage: "FINAL_VIDEO_EXPORT", status: "SUCCESS", message: `Created ${job.finalAssets.length} final video delivery file(s).`, details: { platforms: job.finalAssets.map(asset => asset.platform) } });
    job.approvedDesignIds = ["video_master"];
    job.status = "READY_FOR_PUBLISHING";
    if (deliver) {
      const result = await deliverPublishingAssets(job);
      job.handoffs.push({ type: "PUBLISHING", revisionId: job.currentRevisionId, ...result });
    }
    rememberProcessedKey(job, idempotencyKey);
    appendJobLog(job, { channel: "workflow", stage: "APPROVAL", status: "SUCCESS", message: "Video approval, export and configured publishing work completed." });
    return saveJob(job);
  } catch (error) {
    appendJobLog(job, { channel: "workflow", stage: "APPROVAL", status: "FAILED", message: "Video approval or publishing failed.", details: { error: error.message } });
    job.status = "AWAITING_APPROVAL";
    job.finalAssets = [];
    saveJob(job);
    throw error;
  }
}
