import { appendFileSync, createReadStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { generateWithGeminiWeb } from "./gemini-browser.mjs";
import { inspectOriginalMp4 } from "./mp4-validator.mjs";
import { planGeminiPrompt } from "./qwen-story-planner.mjs";

const cfg = {
  apiUrl: String(process.env.AGENTIC_API_URL || "").replace(/\/$/, ""), token: process.env.GEMINI_VIDEO_WORKER_TOKEN || "",
  workerId: process.env.GEMINI_WORKER_ID || `windows-${process.env.COMPUTERNAME || "pc"}`,
  cdpUrl: process.env.CHROME_CDP_URL || "http://127.0.0.1:9222",
  ollamaBaseUrl: String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
  ollamaModel: process.env.OLLAMA_PLANNER_MODEL || "qwen3:4b", qwenRequired: String(process.env.QWEN_REQUIRED || "true").toLowerCase() !== "false",
  pollMs: Math.max(5000, Number(process.env.WORKER_POLL_SECONDS || 15) * 1000),
  generationTimeoutMs: Math.max(5, Number(process.env.GEMINI_GENERATION_TIMEOUT_MINUTES || 20)) * 60_000,
  downloadDir: resolve(process.env.GEMINI_DOWNLOAD_DIR || fileURLToPath(new URL("./downloads", import.meta.url))),
  logFile: resolve(process.env.GEMINI_WORKER_LOG_FILE || fileURLToPath(new URL("./logs/worker.log", import.meta.url))),
  promptSelector: process.env.GEMINI_PROMPT_SELECTOR || "", videoModeSelector: process.env.GEMINI_VIDEO_MODE_SELECTOR || "",
  downloadSelector: process.env.GEMINI_DOWNLOAD_SELECTOR || "",
  textResponseGraceMs: Math.max(10, Number(process.env.GEMINI_TEXT_RESPONSE_GRACE_SECONDS || 20)) * 1000
};
if (!cfg.apiUrl || !cfg.token) throw new Error("Set AGENTIC_API_URL and GEMINI_VIDEO_WORKER_TOKEN in apps/gemini-video-worker/.env.");

mkdirSync(dirname(cfg.logFile), { recursive: true });
function log(level, event, details = {}) {
  const entry = { at: new Date().toISOString(), level, event, workerId: cfg.workerId, ...details };
  const line = JSON.stringify(entry);
  (level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log)(line);
  try { appendFileSync(cfg.logFile, `${line}\n`, "utf8"); } catch (error) {
    console.error(`[worker-log] Could not append to ${cfg.logFile}: ${error.message}`);
  }
}

const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
async function api(path, body = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${cfg.apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const payload = await response.json().catch(() => ({}));
  log(response.ok ? "INFO" : "ERROR", "agentic_api_response", { path, status: response.status, elapsedMs: Date.now() - startedAt });
  if (!response.ok) throw new Error(payload.error || `Agentic returned HTTP ${response.status}.`);
  return payload;
}
const progress = async (job, status, percent, message, extra = {}) => {
  log("INFO", "job_stage", { jobId: job.id, status, percent, message });
  return api(`/api/video-worker/jobs/${job.id}/progress`, { workerId: cfg.workerId, status, percent, message, ...extra });
};

async function uploadOriginal(job, outputPath, inspection) {
  log("INFO", "upload_ticket_request", { jobId: job.id, byteLength: inspection.byteLength });
  const ticket = await api(`/api/video-worker/jobs/${job.id}/upload-ticket`, { workerId: cfg.workerId });
  const file = await stat(outputPath);
  if (file.size !== inspection.byteLength) throw new Error("Downloaded MP4 changed before upload.");
  const response = await fetch(ticket.uploadUrl, {
    method: "PUT", headers: { "content-type": ticket.contentType, "content-length": String(file.size) },
    body: createReadStream(outputPath), duplex: "half", signal: AbortSignal.timeout(15 * 60_000)
  });
  if (!response.ok) throw new Error(`Object storage upload failed with HTTP ${response.status}.`);
  log("INFO", "object_upload_complete", { jobId: job.id, status: response.status, byteLength: file.size });
  return ticket;
}

async function runJob(job) {
  let heartbeat;
  try {
    log("INFO", "job_started", { jobId: job.id, attempt: job.generationAttempt, productName: job.request?.productName || "" });
    heartbeat = setInterval(() => api(`/api/video-worker/jobs/${job.id}/heartbeat`, { workerId: cfg.workerId })
      .then(() => log("INFO", "heartbeat_ok", { jobId: job.id }))
      .catch(error => log("WARN", "heartbeat_failed", { jobId: job.id, error: error.message })), 60_000);
    await progress(job, "PLANNING", 5, "Qwen is writing the cinematic Gemini prompt.");
    const creativePrompt = await planGeminiPrompt(job, cfg);
    log("INFO", "qwen_prompt_ready", { jobId: job.id, characters: creativePrompt.length });
    await progress(job, "GENERATING", 15, "Gemini is generating the complete video with audio.", { creativePrompt });
    const generated = await generateWithGeminiWeb({ job, prompt: creativePrompt, config: cfg, log });
    await progress(job, "DOWNLOADING", 80, "Gemini's original MP4 has downloaded; validating without modification.");
    const inspection = await inspectOriginalMp4(generated.outputPath);
    log("INFO", "mp4_validated", { jobId: job.id, byteLength: inspection.byteLength, durationSeconds: inspection.durationSeconds, width: inspection.width, height: inspection.height, fps: inspection.fps, sha256: inspection.sha256 });
    await progress(job, "UPLOADING", 88, "Uploading the unchanged original MP4 to cloud storage.");
    await uploadOriginal(job, generated.outputPath, inspection);
    await api(`/api/video-worker/jobs/${job.id}/complete`, {
      workerId: cfg.workerId, ...inspection, originalFilename: generated.suggestedFilename || `${job.id}.mp4`
    });
    log("INFO", "job_ready_for_approval", { jobId: job.id, sha256: inspection.sha256 });
  } catch (error) {
    const retryable = error.retryable !== false;
    log("ERROR", "job_failed", { jobId: job.id, retryable, error: error.message });
    await api(`/api/video-worker/jobs/${job.id}/fail`, { workerId: cfg.workerId, error: error.message, retryable })
      .catch(failure => log("ERROR", "failure_report_failed", { jobId: job.id, error: failure.message }));
  } finally {
    clearInterval(heartbeat);
    log("INFO", "job_finished", { jobId: job.id });
  }
}

log("INFO", "worker_started", { apiUrl: cfg.apiUrl, pollSeconds: cfg.pollMs / 1000, generationTimeoutMinutes: cfg.generationTimeoutMs / 60_000, logFile: cfg.logFile });
for (;;) {
  try {
    const { job } = await api("/api/video-worker/jobs/claim", { workerId: cfg.workerId });
    if (job) {
      log("INFO", "job_claimed", { jobId: job.id, attempt: job.generationAttempt });
      await runJob(job);
    } else {
      log("INFO", "poll_idle", { nextPollSeconds: cfg.pollMs / 1000 });
      await delay(cfg.pollMs);
    }
  } catch (error) {
    log("ERROR", "worker_poll_failed", { error: error.message, nextPollSeconds: cfg.pollMs / 1000 });
    await delay(cfg.pollMs);
  }
}
