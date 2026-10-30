import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { config } from "./config.js";

const editorRoot = fileURLToPath(new URL("../../remotion-video-editor", import.meta.url));

function runEditor(args, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(editorRoot, "render.mjs"), ...args], { cwd: editorRoot, shell: false, windowsHide: true, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout = `${stdout}${chunk}`.slice(-30_000);
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.event === "progress") onProgress?.(event);
        } catch { /* bundler output */ }
      }
    });
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(`Remotion editor exited with ${code}: ${stderr.slice(-1800)}`));
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))); }
      catch { reject(new Error(`Remotion editor returned invalid output: ${stdout.slice(-1000)}`)); }
    });
  });
}

export function remotionAvailable() {
  return existsSync(join(editorRoot, "node_modules", "remotion")) && existsSync(join(editorRoot, "render.mjs"));
}

export async function composeWithRemotion({ workDir, manifest, outputPath, width, height, signal, onProgress }) {
  if (!remotionAvailable()) throw new Error("The Remotion editor dependencies are not installed.");
  const manifestPath = join(workDir, "editable-timeline.json");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, width, height }, null, 2));
  const result = await runEditor(["--input", manifestPath, "--output", outputPath], { signal, onProgress });
  const bytes = await readFile(outputPath);
  return { ...result, bytes, manifestPath };
}
