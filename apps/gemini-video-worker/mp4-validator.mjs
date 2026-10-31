import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as MP4Box from "mp4box";

export async function inspectOriginalMp4(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength < 1024 || bytes.subarray(0, 64).indexOf(Buffer.from("ftyp")) < 0) throw new Error("Gemini download is not a valid MP4 file.");
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  arrayBuffer.fileStart = 0;
  const info = await new Promise((resolve, reject) => {
    const parser = MP4Box.createFile();
    parser.onReady = resolve;
    parser.onError = error => reject(new Error(`MP4 parser rejected the file: ${error}`));
    parser.appendBuffer(arrayBuffer);
    parser.flush();
  });
  const video = info.videoTracks?.[0];
  if (!video) throw new Error("Gemini MP4 contains no video track.");
  const codec = String(video.codec || "").toLowerCase();
  if (!/^(avc1|avc3|hvc1|hev1)/.test(codec)) throw new Error(`Unsupported Meta video codec: ${video.codec || "unknown"}.`);
  const audio = info.audioTracks?.[0];
  if (audio && !/^(mp4a)/i.test(String(audio.codec || ""))) throw new Error(`Unsupported Meta audio codec: ${audio.codec || "unknown"}.`);
  const durationSeconds = Number(info.duration || 0) / Number(info.timescale || 1);
  if (durationSeconds < 3 || durationSeconds > 900) throw new Error(`Unsupported video duration: ${durationSeconds.toFixed(2)} seconds.`);
  if (Number(video.video?.width || video.track_width || 0) > 1920) throw new Error("Video width exceeds Instagram's 1920-pixel maximum.");
  const fps = video.duration ? (Number(video.nb_samples || 0) * Number(video.timescale || 1)) / Number(video.duration) : null;
  if (fps && (fps < 23 || fps > 60.5)) throw new Error(`Unsupported frame rate: ${fps.toFixed(2)} FPS.`);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength,
    durationSeconds: Number(durationSeconds.toFixed(3)), width: Number(video.video?.width || video.track_width || 0) || null,
    height: Number(video.video?.height || video.track_height || 0) || null, fps: fps ? Number(fps.toFixed(3)) : null,
    videoCodec: video.codec, audioCodec: audio?.codec || null
  };
}
