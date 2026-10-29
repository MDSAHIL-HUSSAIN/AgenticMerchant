import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getMediaPath } from "./media-store.js";

const scriptPath = fileURLToPath(new URL("../scripts/transcribe.py", import.meta.url));

export async function transcribeStoredAudio(assetId) {
  if (!config.localWhisperEnabled) return "";
  const inputPath = getMediaPath(assetId);
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonCommand, [scriptPath, inputPath, config.localWhisperModel], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Local Whisper transcription timed out."));
    }, 180_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `Local Whisper exited with code ${code}.`));
      else resolve(stdout.trim());
    });
  });
}
