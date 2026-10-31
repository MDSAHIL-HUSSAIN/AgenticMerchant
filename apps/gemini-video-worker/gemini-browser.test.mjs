import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeGeminiTextOnlyAnswer } from "./gemini-browser.mjs";

test("recognizes Gemini's instructional response instead of a generated video", () => {
  const response = `While this text interface cannot directly render and export an .mp4 video file,
  you can generate this exact clip using Google VideoFX. Here is an 8-Second Production Timecode
  Breakdown. Would you like a quick FFmpeg command?`;
  assert.equal(looksLikeGeminiTextOnlyAnswer(response), true);
});

test("does not classify a short generation status as a text-only answer", () => {
  assert.equal(looksLikeGeminiTextOnlyAnswer("Generating your video. This may take a few minutes."), false);
});
