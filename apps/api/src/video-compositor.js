import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { getMediaPath, readMedia, storeMedia } from "./media-store.js";
import { composeWithVideoWorker } from "./video-worker-client.js";

export function runMediaCommand(command, args, { signal, timeoutMs = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, signal });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      code === 0 ? resolve({ stderr }) : reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

function mockMp4(jobId) {
  return Buffer.concat([Buffer.from("\u0000\u0000\u0000\u0018ftypmp42\u0000\u0000\u0000\u0000mp42isom"), Buffer.from(`VISIONCRAFT-MOCK:${jobId}`)]);
}

export async function composeVideoPreview({ jobId, plan, keyframes, signal, onProgress }) {
  let bytes;
  if (config.videoWorkerMode === "mock") {
    bytes = mockMp4(jobId);
  } else {
    const workDir = join(config.dataDir, "video-work", jobId);
    await mkdir(workDir, { recursive: true });
    const outputPath = join(workDir, "preview.mp4");
    if (config.videoWorkerMode === "worker") {
      await composeWithVideoWorker({
        workDir,
        outputPath,
        ffmpegPath: config.ffmpegPath,
        width: config.videoPreviewWidth,
        height: config.videoPreviewHeight,
        fps: plan.fps,
        durationSeconds: plan.durationSeconds,
        enableGenerativeMotion: config.videoGenerativeMotion,
        enableInterpolation: config.videoUseRife,
        enableUpscale: config.videoUseRealEsrgan,
        enableAceMusic: config.videoUseAceMusic,
        musicPrompt: `${plan.musicDirection} Premium original instrumental advertisement score, 120 BPM, clear four-beat phrasing, evolving arrangement, emotional lift at the midpoint, decisive final resolve, no vocals, no copyrighted melody.`,
        musicBpm: 120,
        musicSeed: plan.shots[0]?.seed || 20261029,
        narrationText: plan.narration?.enabled ? plan.narration.script : "",
        crf: 24,
        shots: keyframes.map((frame, index) => ({
          path: getMediaPath(frame.assetId),
          sourceImagePath: plan.shots[index].sceneType === "PEOPLE"
            ? getMediaPath(frame.assetId)
            : plan.shots[index].productAssetIds?.[0]
              ? getMediaPath(plan.shots[index].productAssetIds[0])
              : getMediaPath(frame.assetId),
          durationSeconds: plan.shots[index].durationSeconds,
          camera: plan.shots[index].camera,
          motion: plan.shots[index].motion,
          renderMode: plan.shots[index].renderMode,
          prompt: plan.shots[index].prompt,
          negativePrompt: plan.shots[index].negativePrompt,
          seed: plan.shots[index].seed
        }))
      }, { signal, onProgress });
    } else {
      const manifestPath = join(workDir, "preview-concat.txt");
      const manifest = [];
      for (let index = 0; index < keyframes.length; index += 1) {
        const path = getMediaPath(keyframes[index].assetId).replaceAll("'", "'\\''");
        manifest.push(`file '${path}'`, `duration ${plan.shots[index].durationSeconds}`);
      }
      manifest.push(`file '${getMediaPath(keyframes.at(-1).assetId).replaceAll("'", "'\\''")}'`);
      await writeFile(manifestPath, `${manifest.join("\n")}\n`);
      await runMediaCommand(config.ffmpegPath, [
        "-y", "-f", "concat", "-safe", "0", "-i", manifestPath,
        "-vf", `scale=${config.videoPreviewWidth}:${config.videoPreviewHeight}:force_original_aspect_ratio=decrease,pad=${config.videoPreviewWidth}:${config.videoPreviewHeight}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${plan.fps},format=yuv420p`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-t", String(plan.durationSeconds), "-movflags", "+faststart", "-an", outputPath
      ], { signal });
    }
    bytes = await readFile(outputPath);
  }
  const video = await storeMedia({
    bytes,
    mimeType: "video/mp4",
    filename: `${jobId}-preview.mp4`,
    kind: "VIDEO_PREVIEW",
    metadata: { videoJobId: jobId, durationSeconds: plan.durationSeconds, width: config.videoPreviewWidth, height: config.videoPreviewHeight, fps: plan.fps }
  });
  const posterSource = await readMedia(keyframes[Math.min(2, keyframes.length - 1)].assetId);
  const poster = await storeMedia({
    bytes: posterSource.bytes,
    mimeType: "image/png",
    filename: `${jobId}-poster.png`,
    kind: "VIDEO_POSTER",
    metadata: { videoJobId: jobId, width: config.videoPreviewWidth, height: config.videoPreviewHeight }
  });
  return {
    video: { assetId: video.id, mimeType: video.mimeType, byteLength: video.byteLength, kind: video.kind },
    poster: { assetId: poster.id, mimeType: poster.mimeType, byteLength: poster.byteLength, kind: poster.kind }
  };
}
