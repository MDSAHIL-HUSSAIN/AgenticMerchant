import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { getMediaPath, storeMedia } from "./media-store.js";
import { runMediaCommand } from "./video-compositor.js";

const cleanIssue = (issue, plan) => {
  const shot = plan.shots.find(item => item.id === issue?.shotId) || plan.shots[Math.max(0, Math.min(plan.shots.length - 1, Number(issue?.shotIndex) || 0))];
  return {
    severity: ["high", "medium", "low"].includes(String(issue?.severity).toLowerCase()) ? String(issue.severity).toLowerCase() : "medium",
    code: String(issue?.code || "VISUAL_QUALITY_ISSUE").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 60),
    shotId: shot?.id,
    message: String(issue?.message || "Visual review found an issue.").slice(0, 400),
    evidence: String(issue?.evidence || "").slice(0, 400),
    suggestedRepair: String(issue?.suggestedRepair || "").slice(0, 400)
  };
};

async function extractFrames(videoPath, plan, reviewDir) {
  await mkdir(reviewDir, { recursive: true });
  const moments = [...new Set(plan.timeline?.inspectionMoments || plan.shots.flatMap(shot => shot.editor?.inspectionMoments || []))]
    .filter(value => Number.isFinite(Number(value)))
    .map(Number)
    .slice(0, 24);
  const frames = [];
  for (let index = 0; index < moments.length; index += 1) {
    const timestamp = moments[index];
    const path = join(reviewDir, `frame-${String(index + 1).padStart(2, "0")}.png`);
    await runMediaCommand(config.ffmpegPath, ["-y", "-ss", String(timestamp), "-i", videoPath, "-frames:v", "1", "-vf", "scale=360:-2", path], { timeoutMs: 120_000 });
    try { await access(path); }
    catch { continue; }
    const shotIndex = Math.max(0, plan.shots.findIndex(shot => timestamp >= shot.editor.startSeconds && timestamp <= shot.editor.endSeconds));
    frames.push({ path, timestamp, shotId: plan.shots[shotIndex]?.id, shotIndex });
  }
  return frames;
}

async function deterministicReview(frames) {
  const issues = [];
  const signatures = [];
  for (const frame of frames) {
    const { data, info } = await sharp(frame.path).resize(48, 48, { fit: "fill" }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
    const variance = data.reduce((sum, value) => sum + (value - mean) ** 2, 0) / data.length;
    signatures.push({ ...frame, mean, variance, data, info });
    if (mean < 7 || variance < 5) issues.push({ severity: "high", code: "BLACK_FRAME", shotId: frame.shotId, message: "The sampled frame is blank or almost black.", evidence: `mean=${mean.toFixed(2)}, variance=${variance.toFixed(2)}` });
  }
  for (let index = 1; index < signatures.length; index += 1) {
    if (signatures[index].shotId !== signatures[index - 1].shotId) continue;
    const difference = signatures[index].data.reduce((sum, value, pixel) => sum + Math.abs(value - signatures[index - 1].data[pixel]), 0) / signatures[index].data.length / 255;
    if (difference < .0025) issues.push({ severity: "medium", code: "STATIC_SHOT", shotId: signatures[index].shotId, message: "The shot samples contain almost no visible change.", evidence: `normalizedDifference=${difference.toFixed(5)}` });
  }
  return issues;
}

async function qwenReview(frames, plan, brief) {
  const images = await Promise.all(frames.map(async frame => (await readFile(frame.path)).toString("base64")));
  const frameMap = frames.map((frame, index) => ({ image: index + 1, timestamp: frame.timestamp, shotId: frame.shotId }));
  const prompt = `/no_think\nAct as a strict advertising film picture editor. Inspect these chronological frames from one product advertisement. Judge product identity, product scale, unintended empty space, crop quality, typography readability, composition, continuity, lighting, transition logic, story progression, and whether the edit feels like a slideshow. Use only visible evidence. Return JSON with {passed,score,summary,issues:[{severity:"high"|"medium"|"low",code,shotId,message,evidence,suggestedRepair}]}. High issues must require a repair before approval. Allowed repair codes include PRODUCT_TOO_SMALL, EXCESS_EMPTY_SPACE, TEXT_UNREADABLE, TEXT_COLLISION, WEAK_TRANSITION, STORY_DISCONTINUITY, STATIC_SHOT, SLIDESHOW_FEEL, PRODUCT_DEFORMATION, IDENTITY_DRIFT, FLICKER, MOTION_GLITCH, BLACK_FRAME.\n\nProduct brief: ${JSON.stringify(brief)}\nStory: ${plan.storyArc}\nFrame map: ${JSON.stringify(frameMap)}\nShot purposes: ${JSON.stringify(plan.shots.map(shot => ({ id: shot.id, purpose: shot.purpose, component: shot.editor?.component, rejectionCriteria: shot.rejectionCriteria })))}`;
  const response = await fetch(`${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.ollamaVisionModel, stream: false, format: "json", keep_alive: 0, messages: [{ role: "user", content: prompt, images }], options: { temperature: .1, num_predict: 2200 } }),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw new Error(`Qwen Vision returned ${response.status}.`);
  const payload = await response.json();
  return JSON.parse(payload.message?.content || "{}");
}

export async function inspectVideoVisuals({ jobId, assetId, plan, brief, pass = 1 }) {
  if (config.videoWorkerMode === "mock") return { passed: true, score: 100, issues: [], skipped: "mock worker", frames: [] };
  const reviewDir = join(config.dataDir, "video-work", jobId, `visual-review-${pass}`);
  const frames = await extractFrames(getMediaPath(assetId), plan, reviewDir);
  const deterministicIssues = await deterministicReview(frames);
  let vision = null;
  let warning = null;
  if (config.videoVisualQa) {
    try { vision = await qwenReview(frames, plan, brief); }
    catch (error) { warning = `Qwen visual review was unavailable: ${error.message}`; }
  }
  const issues = [
    ...deterministicIssues,
    ...(Array.isArray(vision?.issues) ? vision.issues.map(issue => cleanIssue(issue, plan)) : [])
  ];
  const unique = [...new Map(issues.map(issue => [`${issue.code}:${issue.shotId}`, issue])).values()];
  const highCount = unique.filter(issue => issue.severity === "high").length;
  const mediumCount = unique.filter(issue => issue.severity === "medium").length;
  const report = {
    passed: highCount === 0,
    score: Math.max(0, Math.min(100, Number(vision?.score ?? 100) - highCount * 18 - mediumCount * 5)),
    summary: String(vision?.summary || (unique.length ? "Automated frame inspection found correctable issues." : "Automated frame inspection passed.")),
    issues: unique,
    warning,
    evaluator: vision ? config.ollamaVisionModel : "deterministic",
    frames: frames.map(({ path, ...frame }) => frame)
  };
  await writeFile(join(reviewDir, "review.json"), JSON.stringify(report, null, 2));
  const artifact = await storeMedia({ bytes: Buffer.from(JSON.stringify(report, null, 2)), mimeType: "application/json", filename: `${jobId}-visual-review-${pass}.json`, kind: "VIDEO_VISUAL_REVIEW", metadata: { videoJobId: jobId, pass } });
  return { ...report, artifact: { assetId: artifact.id, kind: artifact.kind, mimeType: artifact.mimeType } };
}
