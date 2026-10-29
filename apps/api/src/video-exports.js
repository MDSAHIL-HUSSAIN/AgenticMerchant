import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { getMediaPath, readMedia, storeMedia } from "./media-store.js";
import { runMediaCommand } from "./video-compositor.js";

const formats = [
  { platform: "video_master", width: 1080, height: 1920 },
  { platform: "instagram_reel", width: 1080, height: 1920 },
  { platform: "facebook_reel", width: 1080, height: 1920 },
  { platform: "social_square", width: 1080, height: 1080 },
  { platform: "social_portrait", width: 1080, height: 1350 }
];

export async function createVideoFinalExports(job, { signal } = {}) {
  const preview = job.previewAssets.find(asset => asset.mimeType === "video/mp4");
  const poster = job.previewAssets.find(asset => asset.mimeType === "image/png");
  if (!preview || !poster) throw new Error("Video preview and poster are required before approval.");
  const outputs = [];
  for (const format of formats) {
    let bytes;
    if (config.videoWorkerMode === "mock") {
      bytes = (await readMedia(preview.assetId)).bytes;
    } else {
      const workDir = join(config.dataDir, "video-work", job.id, "exports");
      await mkdir(workDir, { recursive: true });
      const outputPath = join(workDir, `${format.platform}.mp4`);
      await runMediaCommand(config.ffmpegPath, [
        "-y", "-i", getMediaPath(preview.assetId),
        "-vf", `scale=${format.width}:${format.height}:force_original_aspect_ratio=increase,crop=${format.width}:${format.height},format=yuv420p`,
        "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath
      ], { signal, timeoutMs: 3_600_000 });
      bytes = await readFile(outputPath);
    }
    const stored = await storeMedia({ bytes, mimeType: "video/mp4", filename: `${job.id}-${format.platform}.mp4`, kind: "FINAL_VIDEO", metadata: { videoJobId: job.id, revisionId: job.currentRevisionId, ...format, durationSeconds: job.videoSpec.durationSeconds, fps: job.videoSpec.fps } });
    outputs.push({ assetId: stored.id, platform: format.platform, width: format.width, height: format.height, mimeType: stored.mimeType, byteLength: stored.byteLength });
  }
  const posterBytes = (await readMedia(poster.assetId)).bytes;
  const finalPoster = await storeMedia({ bytes: posterBytes, mimeType: "image/png", filename: `${job.id}-poster.png`, kind: "FINAL_VIDEO_POSTER", metadata: { videoJobId: job.id, revisionId: job.currentRevisionId, platform: "poster", width: config.videoPreviewWidth, height: config.videoPreviewHeight } });
  outputs.push({ assetId: finalPoster.id, platform: "poster", width: config.videoPreviewWidth, height: config.videoPreviewHeight, mimeType: finalPoster.mimeType, byteLength: finalPoster.byteLength });
  return outputs;
}
