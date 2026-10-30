import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { getMediaPath, readMedia, storeMedia } from "./media-store.js";
import { composeWithVideoWorker } from "./video-worker-client.js";
import { composeWithRemotion } from "./remotion-client.js";
import { createTimelineManifest } from "./video-timeline.js";

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

const ltxProductDirections = [
  { camera: "slow macro push-in", motion: "a narrow warm highlight travels across the embroidery while the textile remains fixed" },
  { camera: "controlled macro lateral slide", motion: "shallow depth shifts gently across the natural weave; the garment remains stationary" },
  { camera: "locked close-up", motion: "soft directional light reveals the sleeve construction without moving or reshaping the fabric" },
  { camera: "slow vertical macro track", motion: "focus moves across the seam detail while every stitch remains unchanged" },
  { camera: "measured macro pull-back", motion: "the embroidered motif resolves into clarity with only subtle camera parallax" },
  { camera: "locked product close-up", motion: "the final warm highlight settles naturally across the fabric" }
];

const ltxRigidProductDirections = [
  { camera: "slow centered dolly-in", motion: "the camera advances gently while cool RGB reflections move across the fixed chassis" },
  { camera: "controlled left-to-right slider move", motion: "subtle parallax separates the rigid laptop from the studio background" },
  { camera: "locked three-quarter product view", motion: "a narrow blue-violet light sweep reveals the keyboard and hinge; every component stays fixed" },
  { camera: "slow diagonal push", motion: "focus travels from the keyboard toward the screen bezel without changing the product" },
  { camera: "measured hero pull-back", motion: "the complete laptop resolves against restrained RGB atmosphere with no mechanical movement" },
  { camera: "locked hero frame", motion: "the RGB reflections settle into a clean final product hold" }
];

function ltxDirection(frame, index, shot) {
  if (shot?.camera && shot?.motion) return { camera: shot.camera, motion: shot.motion };
  if (frame.ltxProfile === "rigid-product") return ltxRigidProductDirections[index % ltxRigidProductDirections.length];
  if (frame.ltxProfile === "textile-macro") return ltxProductDirections[index % ltxProductDirections.length];
  return { camera: shot.camera, motion: shot.motion };
}

export async function composeVideoPreview({ jobId, plan, keyframes, signal, onProgress }) {
  let bytes;
  let workerReport = null;
  let editorReport = { engine: "ffmpeg", editable: false };
  let timelineArtifact = null;
  if (config.videoWorkerMode === "mock") {
    bytes = mockMp4(jobId);
  } else {
    const workDir = join(config.dataDir, "video-work", jobId);
    await mkdir(workDir, { recursive: true });
    const outputPath = join(workDir, "preview.mp4");
    if (config.videoWorkerMode === "worker") {
      workerReport = await composeWithVideoWorker({
        workDir,
        outputPath,
        ffmpegPath: config.ffmpegPath,
        width: config.videoPreviewWidth,
        height: config.videoPreviewHeight,
        fps: plan.fps,
        durationSeconds: plan.durationSeconds,
        fastTemplateMode: config.videoFastTemplateMode,
        enableGenerativeMotion: config.videoGenerativeMotion && !config.videoFastTemplateMode,
        motionProvider: config.videoMotionProvider,
        motionFallback: config.videoMotionFallback,
        ltx: {
          width: config.ltxWidth,
          height: config.ltxHeight,
          frames: config.ltxFrames,
          fps: config.ltxFps,
          steps: config.ltxSteps,
          candidates: config.ltxCandidates
        },
        framepackCandidateCount: config.framepackCandidates,
        enableInterpolation: !config.videoFastTemplateMode && config.videoUseRife && plan.fps >= 50,
        enableUpscale: !config.videoFastTemplateMode && config.videoUseRealEsrgan,
        enableAceMusic: !config.videoFastTemplateMode && config.videoUseAceMusic,
        musicPrompt: [
          plan.musicDirection,
          `Mood: ${plan.music?.mood || plan.tone}.`,
          `Instrumentation: ${(plan.music?.instruments || []).join(", ")}.`,
          `Structure: ${plan.music?.energyCurve || "restrained opening, hero lift, clean resolve"}.`,
          `Avoid: ${(plan.music?.avoid || ["vocals", "generic corporate music"]).join(", ")}.`,
          "Premium original instrumental product-film score with clear edit points and no copyrighted melody."
        ].join(" "),
        musicMood: plan.music?.mood || plan.tone,
        musicBpm: plan.music?.bpm || 96,
        musicKeyscale: plan.music?.keyscale || "D minor",
        musicTimesignature: plan.music?.timesignature || "4/4",
        musicCandidateCount: 3,
        musicSeed: plan.shots[0]?.seed || 20261029,
        narrationText: plan.narration?.enabled ? plan.narration.script : "",
        audioSampleRate: 48_000,
        crf: 21,
        shots: keyframes.map((frame, index) => ({
          id: plan.shots[index].id,
          path: getMediaPath(frame.assetId),
          overlayPath: frame.overlayAssetId ? getMediaPath(frame.overlayAssetId) : "",
          sourceImagePath: frame.motionPlateAssetId ? getMediaPath(frame.motionPlateAssetId) : getMediaPath(frame.assetId),
          durationSeconds: plan.shots[index].durationSeconds,
          camera: ltxDirection(frame, index, plan.shots[index]).camera,
          motion: ltxDirection(frame, index, plan.shots[index]).motion,
          renderMode: config.videoFastTemplateMode
            ? (index === keyframes.length - 1 ? "DETERMINISTIC" : "HYBRID")
            : plan.shots[index].renderMode,
          productOnly: Boolean(frame.productOnly),
          ltxProfile: frame.ltxProfile || null,
          generation: plan.shots[index].generation,
          edit: plan.shots[index].edit,
          prompt: [
            plan.shots[index].prompt,
            `Over the shot, the camera performs ${ltxDirection(frame, index, plan.shots[index]).camera} while ${ltxDirection(frame, index, plan.shots[index]).motion}.`,
            "Motion begins gently, develops continuously, and settles naturally at the end.",
            frame.ltxProfile === "textile-macro"
              ? "This is a face-free macro product plate: show only the supplied garment material, embroidery and construction detail. Keep the textile stationary while the camera and light move subtly. No person, face, head, skin, hand or body may enter the frame."
              : frame.ltxProfile === "rigid-product"
                ? "This is a rigid-product studio shot. Preserve the exact laptop silhouette, screen, bezel, hinge, keyboard, trackpad, chassis, logos and visible screen artwork. The laptop is completely stationary; only the camera, depth, studio light and existing RGB reflections move. Never open, close, bend, rotate, rebuild or animate any laptop component."
              : "If a person is visible, preserve the same face, anatomy, pose, hands, hair, clothing, embroidery and background throughout.",
            "Keep the result photorealistic and physically plausible; do not redesign or complete anything outside the supplied frame."
          ].join(" "),
          negativePrompt: [
            plan.shots[index].negativePrompt,
            frame.ltxProfile === "textile-macro"
              ? "person, human, face, head, portrait, eyes, mouth, skin, hand, fingers, body, changed garment, changed embroidery, fabric morphing, crawling texture, frame border, empty color panel"
              : frame.ltxProfile === "rigid-product"
                ? "people, hands, changed logo, misspelled text, changing screen content, warped screen, bent keyboard, moving keys, opening laptop, closing laptop, extra hinge, extra keyboard, duplicate laptop, melting chassis, rubber geometry, product deformation, camera shake, flicker"
              : "altered face, distorted face, asymmetrical eyes, detached head, extra limb, missing limb, malformed hands, changed garment, changed embroidery, body discontinuity, frame border, empty color panel"
          ].join(", "),
          seed: plan.shots[index].seed,
          musicCue: plan.shots[index].musicCue,
          soundCues: plan.shots[index].soundCues
        }))
      }, { signal, onProgress });
      if (config.videoEditorEngine === "remotion" && !config.videoFastTemplateMode) {
        const manifest = createTimelineManifest({ jobId, plan, workerReport, keyframes, audioPath: outputPath, renderPass: "preview" });
        const manifestStored = await storeMedia({
          bytes: Buffer.from(JSON.stringify(manifest, null, 2)), mimeType: "application/json",
          filename: `${jobId}-editable-timeline.json`, kind: "VIDEO_EDITABLE_TIMELINE",
          metadata: { videoJobId: jobId, schemaVersion: manifest.schemaVersion, renderPass: "preview" }
        });
        timelineArtifact = { assetId: manifestStored.id, kind: manifestStored.kind, mimeType: manifestStored.mimeType };
        try {
          const remotionOutputPath = join(workDir, "remotion-preview.mp4");
          const rendered = await composeWithRemotion({ workDir, manifest, outputPath: remotionOutputPath, width: config.videoPreviewWidth, height: config.videoPreviewHeight, signal, onProgress });
          bytes = rendered.bytes;
          editorReport = { engine: "remotion", editable: true, outputPath: rendered.outputPath, timelineArtifact };
        } catch (error) {
          editorReport = { engine: "ffmpeg", editable: false, requestedEngine: "remotion", warning: error.message, timelineArtifact };
        }
      }
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
    if (!bytes) bytes = await readFile(outputPath);
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
    metadata: { videoJobId: jobId, width: keyframes[Math.min(2, keyframes.length - 1)].width || config.videoFinalWidth, height: keyframes[Math.min(2, keyframes.length - 1)].height || config.videoFinalHeight }
  });
  return {
    video: { assetId: video.id, mimeType: video.mimeType, byteLength: video.byteLength, kind: video.kind },
    poster: { assetId: poster.id, mimeType: poster.mimeType, byteLength: poster.byteLength, kind: poster.kind },
    workerReport,
    editorReport,
    timelineArtifact
  };
}
