import { getJob, hasProcessedKey, rememberProcessedKey, saveJob } from "./job-store.js";
import { queueVideoRevision } from "./video-orchestrator.js";

const clean = value => String(value || "").replace(/\s+/g, " ").trim();

function revisePlan(job, feedback, shotIds = []) {
  const plan = structuredClone(job.videoSpec);
  const lower = feedback.toLowerCase();
  const targets = new Set(shotIds.length ? shotIds : plan.shots.map(shot => shot.id));
  for (const shot of plan.shots) {
    if (!targets.has(shot.id)) continue;
    if (/slower|calmer|gentler/.test(lower)) shot.motion = `slower, calmer ${shot.motion}`.slice(0, 100);
    if (/faster|more energy|energetic/.test(lower)) shot.motion = `more energetic ${shot.motion}`.slice(0, 100);
    if (/minimal|cleaner|less dramatic/.test(lower)) {
      shot.renderMode = shot.renderMode === "GENERATIVE" ? "HYBRID" : "DETERMINISTIC";
      shot.motion = "restrained premium motion";
    }
    if (/show more.*detail|closer|macro/.test(lower)) shot.camera = "closer macro push-in";
    const headline = feedback.match(/(?:headline|title)\s*(?:to|as|:)\s*["“]?([^"”]+)["”]?/i)?.[1];
    if (headline) shot.copy.headline = clean(headline).slice(0, 64);
    shot.prompt = `${shot.prompt} Revision direction: ${feedback}`.slice(0, 900);
    shot.attempts = Number(shot.attempts || 0) + 1;
    shot.status = "PLANNED";
  }
  if (/less dramatic music|calmer music|minimal music/.test(lower)) plan.musicDirection = "Restrained minimal ambient pulse, sparse tactile percussion, wide dynamic space, no vocals.";
  if (/no voice|remove narration|without narration/.test(lower)) plan.narration = { enabled: false, script: "" };
  return plan;
}

export function applyVideoFeedback(jobId, payload = {}) {
  const job = getJob(jobId);
  if (job.type !== "VIDEO_POST") throw new Error("Video job not found.");
  if (["FINALIZING", "READY_FOR_PUBLISHING"].includes(job.status)) throw new Error("The approved revision is locked.");
  if (job.status !== "AWAITING_APPROVAL") throw new Error("Wait for the current video preview before requesting a revision.");
  const idempotencyKey = payload.idempotencyKey || payload.messageId;
  if (hasProcessedKey(job, idempotencyKey)) return job;
  const feedback = clean(payload.feedback || payload.text);
  if (!feedback) throw new Error("Video revision feedback is required.");
  const shotIds = Array.isArray(payload.shotIds) ? payload.shotIds.map(String) : [];
  const plan = revisePlan(job, feedback, shotIds);
  rememberProcessedKey(job, idempotencyKey);
  saveJob(job);
  return queueVideoRevision(job.id, { plan, feedback: { action: "EDIT_SELECTED", text: feedback, targetShotIds: shotIds }, source: "MERCHANT_FEEDBACK" });
}
