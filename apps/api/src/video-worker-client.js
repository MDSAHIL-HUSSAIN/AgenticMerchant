import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

function workerEnvironment() {
  return {
    ...process.env,
    FRAMEPACK_ROOT: config.framepackRoot,
    FRAMEPACK_MODEL_ROOT: config.framepackModelRoot,
    RIFE_ROOT: config.rifeRoot,
    REALESRGAN_ROOT: config.realEsrganRoot,
    ACESTEP_ROOT: config.aceStepRoot,
    KOKORO_MODEL_ROOT: config.kokoroModelRoot,
    FFMPEG_PATH: config.ffmpegPath,
    FFPROBE_PATH: config.ffprobePath
  };
}

function runWorker(args, { signal, timeoutMs = 3_600_000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.videoWorkerPython, [config.videoWorkerPath, ...args], {
      shell: false, windowsHide: true, signal, env: workerEnvironment()
    });
    let stdout = "";
    let lineBuffer = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout = `${stdout}${text}`.slice(-100_000);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line.trim());
          if (event.event === "progress") onProgress?.(event);
        } catch { /* third-party model logs are not protocol messages */ }
      }
    });
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Video worker exited with ${code}: ${stderr.slice(-2000)}`));
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))); }
      catch { reject(new Error(`Video worker returned invalid JSON: ${stdout.slice(-1000)}`)); }
    });
  });
}

export function getVideoWorkerHealth() {
  // Cold imports of Torch/CUDA and the isolated model runtimes can exceed 30s
  // on Windows even though the worker is healthy.
  return runWorker(["health"], { timeoutMs: 120_000 });
}

export async function composeWithVideoWorker(spec, { signal, onProgress } = {}) {
  const workDir = spec.workDir;
  await mkdir(workDir, { recursive: true });
  const specPath = join(workDir, "compose-spec.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2));
  return runWorker(["compose", "--spec", specPath], { signal, onProgress, timeoutMs: 7_200_000 });
}
