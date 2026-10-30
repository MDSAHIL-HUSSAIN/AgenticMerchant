import { spawn } from "node:child_process";
import { config } from "./config.js";
import { getMediaPath, mediaFileInfo, readMedia } from "./media-store.js";
import sharp from "sharp";

function probeVideo(assetId) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffprobePath, [
      "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,duration,sample_rate,channels,bit_rate:format=duration,bit_rate",
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

function measureFrozenVideo(assetId, durationSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, [
      "-v", "info", "-i", getMediaPath(assetId),
      "-vf", "freezedetect=n=-50dB:d=0.7", "-an", "-f", "null", "NUL"
    ], { shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-80_000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`Freeze analysis exited with ${code}.`));
      const durations = [...stderr.matchAll(/freeze_duration:\s*([\d.]+)/gi)].map(match => Number(match[1])).filter(Number.isFinite);
      const starts = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/gi)].map(match => Number(match[1])).filter(Number.isFinite);
      if (starts.length > durations.length && Number.isFinite(durationSeconds)) durations.push(Math.max(0, durationSeconds - starts.at(-1)));
      resolve({ segments: durations.length, totalSeconds: durations.reduce((sum, value) => sum + value, 0), longestSeconds: durations.length ? Math.max(...durations) : 0 });
    });
  });
}

export function inspectVideoPlan(plan) {
  const issues = [];
  const total = Math.round(plan.shots.reduce((sum, shot) => sum + Number(shot.durationSeconds || 0), 0) * 10) / 10;
  if (Math.abs(total - plan.durationSeconds) > .05) issues.push({ severity: "high", code: "DURATION_MISMATCH", expected: plan.durationSeconds, actual: total });
  if (plan.shots.length < 5 || plan.shots.length > 12) issues.push({ severity: "high", code: "INVALID_SHOT_COUNT", actual: plan.shots.length });
  const generativeCount = plan.shots.filter(shot => shot.renderMode === "GENERATIVE").length;
  const productCount = plan.shots.filter(shot => shot.sceneType === "PRODUCT").length;
  const minimumGenerativeCount = Math.ceil(plan.shots.length * .45);
  const maximumGenerativeCount = Math.max(minimumGenerativeCount, Math.floor(plan.shots.length * .75));
  if (!config.videoFastTemplateMode && (generativeCount < minimumGenerativeCount || generativeCount > maximumGenerativeCount)) issues.push({ severity: "high", code: "INVALID_GENERATIVE_SHOT_COUNT", minimum: minimumGenerativeCount, maximum: maximumGenerativeCount, actual: generativeCount });
  if (plan.shots.at(-1)?.renderMode !== "DETERMINISTIC") issues.push({ severity: "high", code: "UNSAFE_FINAL_LOCKUP" });
  if (productCount !== plan.shots.length) issues.push({ severity: "high", code: "PRODUCT_FILM_CONTAINS_NON_PRODUCT_SCENE", actual: plan.shots.length - productCount });
  if (!plan.storyArc) issues.push({ severity: "high", code: "MISSING_STORY_ARC" });
  if (plan.schemaVersion !== 2 || plan.editor?.engine !== "remotion" || !plan.timeline?.inspectionMoments?.length) issues.push({ severity: "high", code: "MISSING_EDITABLE_TIMELINE" });
  if (!plan.continuity?.product || !plan.continuity?.lighting) issues.push({ severity: "high", code: "MISSING_CONTINUITY_BIBLE" });
  if (!plan.music?.mood || !plan.music?.energyCurve || !plan.music?.instruments?.length) issues.push({ severity: "high", code: "MISSING_MUSIC_DIRECTION" });
  if (!Number.isFinite(Number(plan.music?.bpm)) || Number(plan.music.bpm) < 60 || Number(plan.music.bpm) > 160) issues.push({ severity: "high", code: "INVALID_MUSIC_BPM" });
  const focusSignatures = new Set(plan.shots.map(shot => `${Math.round((shot.focus?.x || 0) * 10)}:${Math.round((shot.focus?.y || 0) * 10)}:${Math.round((shot.focus?.zoom || 1) * 10)}`));
  if (focusSignatures.size < Math.min(4, plan.shots.length)) issues.push({ severity: "high", code: "INSUFFICIENT_VISUAL_FRAMING_VARIETY", actual: focusSignatures.size });
  for (const shot of plan.shots) {
    if (!shot.prompt) issues.push({ severity: "high", code: "MISSING_PROMPT", shotId: shot.id });
    if (!shot.editor?.component || !shot.editor?.motionCurve || !shot.editor?.inspectionMoments?.length) issues.push({ severity: "high", code: "MISSING_EDITING_INSTRUCTIONS", shotId: shot.id });
    if (!shot.renderMode) issues.push({ severity: "high", code: "MISSING_RENDER_MODE", shotId: shot.id });
    if (!shot.stage?.backgroundStyle || !shot.edit?.style || !shot.edit?.transitionOut) issues.push({ severity: "high", code: "MISSING_DIRECTORIAL_INSTRUCTIONS", shotId: shot.id });
    if (shot.renderMode === "GENERATIVE" && (!Number.isInteger(shot.generation?.frames) || (shot.generation.frames - 1) % 8 !== 0 || shot.generation?.steps !== 8)) issues.push({ severity: "high", code: "INVALID_LTX_SHOT_PROFILE", shotId: shot.id });
    for (const field of ["composition", "lighting", "cutIntention"]) {
      if (!shot[field]) issues.push({ severity: "high", code: `MISSING_${field.replace(/([A-Z])/g, "_$1").toUpperCase()}`, shotId: shot.id });
    }
    if (!shot.rejectionCriteria?.length) issues.push({ severity: "high", code: "MISSING_REJECTION_CRITERIA", shotId: shot.id });
    if (!shot.soundCues?.length) issues.push({ severity: "medium", code: "MISSING_SOUND_CUES", shotId: shot.id });
    if (!shot.musicCue || !Number.isFinite(Number(shot.musicCue.beat))) issues.push({ severity: "high", code: "MISSING_BEAT_ALIGNED_CUT", shotId: shot.id });
    if (/(logo|price|cta|call to action)/i.test(shot.prompt) && shot.renderMode === "GENERATIVE") issues.push({ severity: "medium", code: "GENERATIVE_TEXT_RISK", shotId: shot.id });
  }
  return { passed: !issues.some(issue => issue.severity === "high"), score: Math.max(0, 100 - issues.reduce((sum, issue) => sum + (issue.severity === "high" ? 25 : 8), 0)), totalDurationSeconds: total, issues };
}

export async function inspectVideoKeyframes(keyframes) {
  if (config.videoWorkerMode === "mock") return { passed: true, score: 100, issues: [], differences: [], skipped: "mock worker" };
  const issues = [];
  const fingerprints = [];
  for (const frame of keyframes) {
    const { bytes } = await readMedia(frame.assetId);
    const pixels = await sharp(bytes).resize(16, 16, { fit: "fill" }).grayscale().raw().toBuffer();
    fingerprints.push([...pixels]);
  }
  const differences = [];
  for (let index = 1; index < fingerprints.length; index += 1) {
    const left = fingerprints[index - 1];
    const right = fingerprints[index];
    differences.push(left.reduce((sum, value, pixel) => sum + Math.abs(value - right[pixel]), 0) / (left.length * 255));
  }
  const distinctTransitions = differences.filter(value => value >= .035).length;
  if (distinctTransitions < Math.max(2, keyframes.length - 2)) {
    issues.push({ severity: "high", code: "REPEATED_OR_NEAR_IDENTICAL_KEYFRAMES", distinctTransitions, totalTransitions: differences.length });
  }
  return { passed: !issues.length, score: issues.length ? 0 : 100, issues, differences: differences.map(value => Number(value.toFixed(4))) };
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
      const audioStream = result.streams?.find(item => item.codec_type === "audio") || null;
      const hasAudio = Boolean(audioStream);
      const containerDurationSeconds = Number(result.format?.duration);
      const videoDurationSeconds = Number(stream.duration || result.format?.duration);
      probe = { durationSeconds: videoDurationSeconds, containerDurationSeconds, width: Number(stream.width), height: Number(stream.height), frameRate: stream.avg_frame_rate, hasAudio, audioSampleRate: Number(audioStream?.sample_rate || 0), audioChannels: Number(audioStream?.channels || 0), videoBitRate: Number(stream.bit_rate || 0) };
      if (expected.durationSeconds && Math.abs(probe.durationSeconds - expected.durationSeconds) > .15) issues.push({ severity: "high", code: "RENDERED_DURATION_MISMATCH", expected: expected.durationSeconds, actual: probe.durationSeconds });
      if (expected.width && probe.width !== expected.width) issues.push({ severity: "high", code: "RENDERED_WIDTH_MISMATCH", expected: expected.width, actual: probe.width });
      if (expected.height && probe.height !== expected.height) issues.push({ severity: "high", code: "RENDERED_HEIGHT_MISMATCH", expected: expected.height, actual: probe.height });
      if (expected.audio !== false && !hasAudio) issues.push({ severity: "high", code: "MISSING_AUDIO_TRACK" });
      if (hasAudio) {
        if (probe.audioSampleRate !== 48_000) issues.push({ severity: "high", code: "NONSTANDARD_AUDIO_SAMPLE_RATE", expected: 48_000, actual: probe.audioSampleRate });
        if (probe.audioChannels !== 2) issues.push({ severity: "high", code: "INVALID_AUDIO_CHANNEL_COUNT", expected: 2, actual: probe.audioChannels });
        const loudness = await measureAudioLoudness(assetId);
        probe.loudness = loudness;
        if (!Number.isFinite(loudness.meanDb) || loudness.meanDb < -38 || loudness.peakDb < -30) {
          issues.push({ severity: "high", code: "INAUDIBLE_AUDIO_TRACK", ...loudness });
        }
      }
      const freeze = await measureFrozenVideo(assetId, probe.durationSeconds);
      probe.freeze = freeze;
      const longestAllowed = Math.max(3.5, probe.durationSeconds * .30);
      if (freeze.longestSeconds > longestAllowed || freeze.totalSeconds > probe.durationSeconds * .48) {
        issues.push({ severity: "high", code: "EXCESSIVE_FROZEN_VIDEO", ...freeze, longestAllowedSeconds: longestAllowed });
      }
    } catch (error) {
      issues.push({ severity: "high", code: "FFPROBE_FAILED", message: error.message });
    }
  }
  return { passed: !issues.length, score: issues.length ? 0 : 100, issues, byteLength: size, probe };
}
