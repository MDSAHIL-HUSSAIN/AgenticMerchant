process.env.VIDEO_WORKER_MODE = "worker";
process.env.VIDEO_POST_ENABLED = "true";

const jobId = process.env.RETRY_VIDEO_JOB_ID;
if (!jobId) throw new Error("Set RETRY_VIDEO_JOB_ID.");

const { retryVideoJob, waitForVideoJob } = await import("../src/video-orchestrator.js");
const { approveVideoJob } = await import("../src/video-approvals.js");

retryVideoJob(jobId);
const ready = await waitForVideoJob(jobId, { timeoutMs: 7_200_000 });
if (ready.status !== "AWAITING_APPROVAL") {
  throw new Error(ready.error || `Unexpected status ${ready.status}`);
}
const approved = await approveVideoJob(jobId, {
  idempotencyKey: `cinematic-retry-${jobId}`,
  deliver: false
});
console.log(JSON.stringify({
  ok: true,
  jobId,
  status: approved.status,
  qa: ready.qa,
  finalAssets: approved.finalAssets
}, null, 2));
