import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function firstExisting(...candidates) {
  return candidates.find(candidate => candidate && existsSync(candidate)) || candidates.find(Boolean) || "";
}

const bundledFfmpegBin = "C:\\Users\\sahil\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin";
const framepackPython = "D:\\AI-Models\\runtimes\\framepack-py311\\Scripts\\python.exe";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

export const config = {
  port: Number(process.env.PORT || 8787),
  dataDir: process.env.DATA_DIR || fileURLToPath(new URL("../data", import.meta.url)),
  stateDbPath: process.env.STATE_DB_PATH || fileURLToPath(new URL("../data/agentic-state.sqlite", import.meta.url)),
  demoMode: String(process.env.DEMO_MODE ?? "true").toLowerCase() !== "false",
  designCount: Math.max(1, Math.min(6, Number(process.env.DESIGN_COUNT || 1))),
  autonomousVisionQa: String(process.env.AUTONOMOUS_VISION_QA ?? "false").toLowerCase() === "true",
  autonomousMediaAnalysis: String(process.env.AUTONOMOUS_MEDIA_ANALYSIS ?? "false").toLowerCase() === "true",
  autonomousRevisionAi: String(process.env.AUTONOMOUS_REVISION_AI ?? "false").toLowerCase() === "true",
  maxAutomaticRepairs: Math.max(0, Math.min(3, Number(process.env.MAX_AUTOMATIC_REPAIRS || 3))),
  localWhisperEnabled: String(process.env.LOCAL_WHISPER_ENABLED ?? "false").toLowerCase() === "true",
  localWhisperModel: process.env.LOCAL_WHISPER_MODEL || "small",
  pythonCommand: process.env.PYTHON_COMMAND || "python",
  whatsappHandoffUrl: process.env.WHATSAPP_HANDOFF_URL || "",
  publishingHandoffUrl: process.env.PUBLISHING_HANDOFF_URL || "",
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || "",
  facebookCloudinaryCloudName: process.env.FACEBOOK_CLOUDINARY_CLOUD_NAME || "",
  facebookCloudinaryApiKey: process.env.FACEBOOK_CLOUDINARY_API_KEY || "",
  facebookCloudinaryApiSecret: process.env.FACEBOOK_CLOUDINARY_API_SECRET || "",
  facebookPublishUrl: process.env.FACEBOOK_PUBLISH_URL || "",
  facebookPublishSecret: process.env.FACEBOOK_PUBLISH_SECRET || "",
  serpApiKey: process.env.SERPAPI_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  pixabayApiKey: process.env.PIXABAY_API_KEY || "",
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || "",
  cloudflareImageModel: process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell",
  videoPostEnabled: String(process.env.VIDEO_POST_ENABLED ?? "true").toLowerCase() === "true",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  ollamaPlannerModel: process.env.OLLAMA_PLANNER_MODEL || "qwen3:8b",
  autonomousVideoPlanning: String(process.env.AUTONOMOUS_VIDEO_PLANNING ?? "true").toLowerCase() !== "false",
  videoWorkerPython: process.env.VIDEO_WORKER_PYTHON || firstExisting(framepackPython, process.env.PYTHON_COMMAND, "python"),
  videoWorkerPath: process.env.VIDEO_WORKER_PATH || fileURLToPath(new URL("../../video-worker/worker.py", import.meta.url)),
  framepackRoot: process.env.FRAMEPACK_ROOT || firstExisting("D:\\AI-Models\\FramePack"),
  framepackModelRoot: process.env.FRAMEPACK_MODEL_ROOT || firstExisting("D:\\AI-Models\\FramePack\\models"),
  rifeRoot: process.env.RIFE_ROOT || firstExisting("D:\\AI-Models\\Practical-RIFE", "D:\\AI-Models\\ECCV2022-RIFE"),
  realEsrganRoot: process.env.REALESRGAN_ROOT || firstExisting("D:\\AI-Models\\Real-ESRGAN"),
  aceStepRoot: process.env.ACESTEP_ROOT || firstExisting("D:\\AI-Models\\ACE-Step"),
  aceStepBaseUrl: process.env.ACESTEP_BASE_URL || "http://127.0.0.1:8001",
  kokoroModelRoot: process.env.KOKORO_MODEL_ROOT || firstExisting("D:\\AI-Models\\Kokoro-82M"),
  ffmpegPath: process.env.FFMPEG_PATH || firstExisting(`${bundledFfmpegBin}\\ffmpeg.exe`, "ffmpeg"),
  ffprobePath: process.env.FFPROBE_PATH || firstExisting(`${bundledFfmpegBin}\\ffprobe.exe`, "ffprobe"),
  videoPreviewWidth: Math.max(270, Number(process.env.VIDEO_PREVIEW_WIDTH || 540)),
  videoPreviewHeight: Math.max(480, Number(process.env.VIDEO_PREVIEW_HEIGHT || 960)),
  videoFinalWidth: Math.max(540, Number(process.env.VIDEO_FINAL_WIDTH || 1080)),
  videoFinalHeight: Math.max(960, Number(process.env.VIDEO_FINAL_HEIGHT || 1920)),
  videoDefaultDurationSeconds: Math.max(8, Math.min(60, Number(process.env.VIDEO_DEFAULT_DURATION_SECONDS || 30))),
  videoDefaultFps: [24, 25, 30, 50, 60].includes(Number(process.env.VIDEO_DEFAULT_FPS)) ? Number(process.env.VIDEO_DEFAULT_FPS) : 30,
  maxVideoShotRepairs: Math.max(0, Math.min(4, Number(process.env.MAX_VIDEO_SHOT_REPAIRS || 2))),
  maxVideoJobRepairs: Math.max(0, Math.min(20, Number(process.env.MAX_VIDEO_JOB_REPAIRS || 8))),
  videoTempRetentionHours: Math.max(1, Number(process.env.VIDEO_TEMP_RETENTION_HOURS || 24)),
  videoWorkerMode: process.env.VIDEO_WORKER_MODE || "worker",
  videoGenerativeMotion: String(process.env.VIDEO_GENERATIVE_MOTION ?? "true").toLowerCase() !== "false",
  videoUseRife: String(process.env.VIDEO_USE_RIFE ?? "true").toLowerCase() !== "false",
  videoUseRealEsrgan: String(process.env.VIDEO_USE_REALESRGAN ?? "true").toLowerCase() !== "false",
  videoUseAceMusic: String(process.env.VIDEO_USE_ACE_MUSIC ?? "true").toLowerCase() !== "false"
};

export function providerStatus() {
  return {
    mode: config.demoMode ? "demo" : "live",
    serpApi: Boolean(config.serpApiKey),
    tavily: Boolean(config.tavilyApiKey),
    gemini: Boolean(config.geminiApiKey),
    pixabay: Boolean(config.pixabayApiKey),
    cloudflareWorkersAi: Boolean(config.cloudflareAccountId && config.cloudflareApiToken),
    autonomousVisionQa: Boolean(config.autonomousVisionQa && config.geminiApiKey),
    autonomousMediaAnalysis: Boolean(config.autonomousMediaAnalysis && config.geminiApiKey),
    autonomousRevisionAi: Boolean(config.autonomousRevisionAi && config.geminiApiKey),
    localWhisper: config.localWhisperEnabled,
    videoPost: config.videoPostEnabled,
    videoWorkerMode: config.videoWorkerMode,
    localVideoPlanner: Boolean(config.autonomousVideoPlanning && config.ollamaBaseUrl),
    facebookPublisher: Boolean(
      config.facebookCloudinaryCloudName &&
      config.facebookCloudinaryApiKey &&
      config.facebookCloudinaryApiSecret &&
      config.facebookPublishUrl &&
      config.facebookPublishSecret
    )
  };
}
