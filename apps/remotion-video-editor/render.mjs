import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, getCompositions, renderMedia } from "@remotion/renderer";

const root = fileURLToPath(new URL(".", import.meta.url));
const valueFor = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const rawInputPath = valueFor("--input");
const rawOutputPath = valueFor("--output");
if (!rawInputPath || !rawOutputPath) throw new Error("--input and --output are required.");
const inputPath = resolve(rawInputPath);
const outputPath = resolve(rawOutputPath);
const manifest = JSON.parse(await readFile(inputPath, "utf8"));
const publicDir = join(root, ".cache", `public-${manifest.jobId}`);
await rm(publicDir, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });
for (let index = 0; index < manifest.shots.length; index += 1) {
  const shot = manifest.shots[index];
  const sourcePath = shot.source?.path;
  if (!sourcePath) throw new Error(`Shot ${shot.id} has no editable source.`);
  const publicName = `shot-${String(index + 1).padStart(2, "0")}${extname(sourcePath) || ".png"}`;
  await copyFile(sourcePath, join(publicDir, publicName));
  shot.source.publicName = publicName;
}
if (manifest.audioPath) {
  manifest.audioPublicName = `audio-bed${extname(manifest.audioPath) || ".mp4"}`;
  await copyFile(manifest.audioPath, join(publicDir, manifest.audioPublicName));
}
console.log(JSON.stringify({ event: "progress", stage: "REMOTION_BUNDLE", progress: 77, message: "Preparing the editable motion-graphics composition." }));
await ensureBrowser();
const serveUrl = await bundle({ entryPoint: join(root, "src", "index.jsx"), publicDir, onProgress: () => undefined });
const inputProps = { manifest };
const compositions = await getCompositions(serveUrl, { inputProps });
const composition = compositions.find(item => item.id === "ProductFilm");
if (!composition) throw new Error("The ProductFilm composition was not registered.");
console.log(JSON.stringify({ event: "progress", stage: "REMOTION_RENDER", progress: 80, message: "Rendering the editable picture edit and motion graphics." }));
await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outputPath, inputProps, crf: 21, pixelFormat: "yuv420p", audioCodec: "aac", onProgress: () => undefined });
console.log(JSON.stringify({ ok: true, outputPath, engine: "remotion", editableTimeline: inputPath }));
