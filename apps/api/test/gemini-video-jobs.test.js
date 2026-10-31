import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const directory = mkdtempSync(join(tmpdir(), "agentic-gemini-video-test-"));
process.env.STATE_DB_PATH = join(directory, "state.sqlite");
process.env.GEMINI_WEB_VIDEO_ENABLED = "true";
process.env.DATABASE_URL = "";

const {
  claimNextGeminiVideoJob, createGeminiVideoJob, failGeminiVideoJob,
  getPublicGeminiVideoJob, updateGeminiVideoProgress
} = await import("../src/gemini-video-jobs.js");

test("durably queues, leases and retries a Gemini web video job", async () => {
  const created = await createGeminiVideoJob({
    merchantId: "merchant-1",
    productName: "Maggi noodles",
    instructions: "Create a cinematic expiry offer video",
    targetChannels: ["instagram", "facebook", "unsupported"]
  });
  assert.equal(created.status, "QUEUED");
  assert.deepEqual(created.targetChannels, ["instagram", "facebook"]);
  assert.equal(created.request.productImageUrl, null);

  const claimed = await claimNextGeminiVideoJob("test-worker");
  assert.equal(claimed.id, created.id);
  assert.equal(claimed.status, "CLAIMED");

  const planning = await updateGeminiVideoProgress(created.id, "test-worker", {
    status: "PLANNING", percent: 5, message: "Qwen is planning.", creativePrompt: "One complete prompt"
  });
  assert.equal(planning.status, "PLANNING");
  assert.equal(planning.creativePrompt, "One complete prompt");

  const retried = await failGeminiVideoJob(created.id, "test-worker", { error: "Gemini UI changed", retryable: true });
  assert.equal(retried.status, "RETRY");
  assert.equal(retried.generationAttempt, 2);

  const persisted = await getPublicGeminiVideoJob(created.id);
  assert.equal(persisted.status, "RETRY");
  assert.equal(persisted.error, "Gemini UI changed");
});
