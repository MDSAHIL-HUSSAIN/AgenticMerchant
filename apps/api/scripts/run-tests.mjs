import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../test", import.meta.url));
const tests = readdirSync(testDirectory)
  .filter(name => name.endsWith(".test.js"))
  .map(name => fileURLToPath(new URL(`../test/${name}`, import.meta.url)));

const child = spawn(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  shell: false,
  env: { ...process.env, VIDEO_WORKER_MODE: "mock", VIDEO_POST_ENABLED: "true", AUTONOMOUS_VIDEO_PLANNING: "false" }
});
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("close", code => { process.exitCode = code ?? 1; });
