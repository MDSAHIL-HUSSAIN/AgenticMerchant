import { spawn } from "node:child_process";
import { config } from "./config.js";
import { getMediaPath, mediaFileInfo } from "./media-store.js";

function probeVideo(assetId) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffprobePath, [
      "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,duration:format=duration",
      "-of", "json", getMediaPath(assetId)
    ], { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`ffprobe exited with ${code}: ${stderr.slice(-1000)}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("ffprobe returned invalid JSON.")); }
    });
  });
}

function measureAudioLoudness(assetId) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ["-v", "info", "-i", getMediaPath(assetId), "-af", "volumedetect", "-f", "null", "NUL"], { shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`Audio loudness analysis exited with ${code}.`));
      const mean = Number(stderr.match(/mean_volume:\s*(-?[\d.]+) dB/i)?.[1]);
      const peak = Number(stderr.match(/max_volume:\s*(-?[\d.]+) dB/i)?.[1]);
      resolve({ meanDb: mean, peakDb: peak });
    });
  });
}

export function inspectVideoPlan(plan) {
  const issues = [];
  const total = Math.round(plan.shots.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0) * 10) / 10;
  if (Math.abs(total - plan.durationSeconds) > .05) issues.push({ severity: "high", code: "DURATION_MISMATCH", expected: plan.durationSeconds, actual: total });
  if (plan.shots.length < 3 || plan.shots.length > 12) issues.push({ severity: "high", code: "INVALID_SHOT_COUNT", actual: plan.shots.length });
  for (const shot of plan.shots) {
    if (!shot.prompt) issues.push({ severity: "high", code: "MISSING_PROMPT", shotId: shot.id });
    if (!shot.renderMode) issues.push({ severity: "high", code: "MISSING_RENDER_MODE", shotId: shot.id });
    if (/(logo|price|cta|call to action)/i.test(shot.prompt) && shot.renderMode === "GENERATIVE") issues.push({ severity: "medium", code: "GENERATIVE_TEXT_RISK", shotId: shot.id });
  }
  return { passed: !issues.some(issue => issue.severity === "high"), score: Math.max(0, 100 - issues.reduce((sum, issue) => sum + (issue.severity === "high" ? 25 : 8), 0)), totalDurationSeconds: total, issues };
}

export async function inspectVideoPreview(assetId, expected = {}) {
  const { record, size } = await mediaFileInfo(assetId);
  const issues = [];
  if (record.mimeType !== "video/mp4") issues.push({ severity: "high", code: "INVALID_VIDEO_MIME" });
  if (size < 24) issues.push({ severity: "high", code: "EMPTY_VIDEO" });
  let probe = null;
  if (config.videoWorkerMode !== "mock" && !issues.length) {
    try {
      const result = await probeVideo(assetId);
      const stream = result.streams?.find(item => item.codec_type === "video") || {};
      const hasAudio = result.streams?.some(item => item.codec_type === "audio") || false;
      const containerDurationSeconds = Number(result.format?.duration);
      const videoDurationSeconds = Number(stream.duration || result.format?.duration);
      probe = { durationSeconds: videoDurationSeconds, containerDurationSeconds, width: Number(stream.width), height: Number(stream.height), frameRate: stream.avg_frame_rate, hasAudio };
      if (expected.durationSeconds && Math.abs(probe.durationSeconds - expected.durationSeconds) > .15) issues.push({ severity: "high", code: "RENDERED_DURATION_MISMATCH", expected: expected.durationSeconds, actual: probe.durationSeconds });
      if (expected.width && probe.width !== expected.width) issues.push({ severity: "high", code: "RENDERED_WIDTH_MISMATCH", expected: expected.width, actual: probe.width });
      if (expected.height && probe.height !== expected.height) issues.push({ severity: "high", code: "RENDERED_HEIGHT_MISMATCH", expected: expected.height, actual: probe.height });
      if (expected.audio !== false && !hasAudio) issues.push({ severity: "high", code: "MISSING_AUDIO_TRACK" });
      if (hasAudio) {
        const loudness = await measureAudioLoudness(assetId);
        probe.loudness = loudness;
        if (!Number.isFinite(loudness.meanDb) || loudness.meanDb < -38 || loudness.peakDb < -30) {
          issues.push({ severity: "high", code: "INAUDIBLE_AUDIO_TRACK", ...loudness });
        }
      }
    } catch (error) {
      issues.push({ severity: "high", code: "FFPROBE_FAILED", message: error.message });
    }
  }
  return { passed: !issues.length, score: issues.length ? 0 : 100, issues, byteLength: size, probe };
}
