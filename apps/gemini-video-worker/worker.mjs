import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
  downloadDir: resolve(process.env.GEMINI_DOWNLOAD_DIR || new URL("./downloads", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")),
  promptSelector: process.env.GEMINI_PROMPT_SELECTOR || "", videoModeSelector: process.env.GEMINI_VIDEO_MODE_SELECTOR || "",
  downloadSelector: process.env.GEMINI_DOWNLOAD_SELECTOR || ""
};
if (!cfg.apiUrl || !cfg.token) throw new Error("Set AGENTIC_API_URL and GEMINI_VIDEO_WORKER_TOKEN in apps/gemini-video-worker/.env.");

const headers = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" };
async function api(path, body = {}) {
  const response = await fetch(`${cfg.apiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Agentic returned HTTP ${response.status}.`);
  return payload;
}
const progress = (job, status, percent, message, extra = {}) => api(`/api/video-worker/jobs/${job.id}/progress`, { workerId: cfg.workerId, status, percent, message, ...extra });

async function uploadOriginal(job, outputPath, inspection) {
  const ticket = await api(`/api/video-worker/jobs/${job.id}/upload-ticket`, { workerId: cfg.workerId });
  const file = await stat(outputPath);
  if (file.size !== inspection.byteLength) throw new Error("Downloaded MP4 changed before upload.");
  const response = await fetch(ticket.uploadUrl, {
    method: "PUT", headers: { "content-type": ticket.contentType, "content-length": String(file.size) },
    body: createReadStream(outputPath), duplex: "half", signal: AbortSignal.timeout(15 * 60_000)
  });
  if (!response.ok) throw new Error(`Object storage upload failed with HTTP ${response.status}.`);
  return ticket;
}

async function runJob(job) {
  let heartbeat;
  try {
    heartbeat = setInterval(() => api(`/api/video-worker/jobs/${job.id}/heartbeat`, { workerId: cfg.workerId }).catch(() => {}), 60_000);
    await progress(job, "PLANNING", 5, "Qwen is writing the cinematic Gemini prompt.");
    const creativePrompt = await planGeminiPrompt(job, cfg);
    await progress(job, "GENERATING", 15, "Gemini is generating the complete video with audio.", { creativePrompt });
    const generated = await generateWithGeminiWeb({ job, prompt: creativePrompt, config: cfg });
    await progress(job, "DOWNLOADING", 80, "Gemini's original MP4 has downloaded; validating without modification.");
    const inspection = await inspectOriginalMp4(generated.outputPath);
    await progress(job, "UPLOADING", 88, "Uploading the unchanged original MP4 to cloud storage.");
    await uploadOriginal(job, generated.outputPath, inspection);
    await api(`/api/video-worker/jobs/${job.id}/complete`, {
      workerId: cfg.workerId, ...inspection, originalFilename: generated.suggestedFilename || `${job.id}.mp4`
    });
    console.log(`[${new Date().toISOString()}] ${job.id} ready for merchant approval (${inspection.sha256}).`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${job.id} failed: ${error.message}`);
    await api(`/api/video-worker/jobs/${job.id}/fail`, { workerId: cfg.workerId, error: error.message, retryable: true }).catch(failure => console.error(`Could not report failure: ${failure.message}`));
  } finally {
    clearInterval(heartbeat);
  }
}

console.log(`Gemini video worker ${cfg.workerId} is polling ${cfg.apiUrl}. Chrome remains in the dedicated minimized profile.`);
for (;;) {
  try {
    const { job } = await api("/api/video-worker/jobs/claim", { workerId: cfg.workerId });
    if (job) await runJob(job); else await delay(cfg.pollMs);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Worker poll failed: ${error.message}`);
    await delay(cfg.pollMs);
  }
}
