import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const defaultPromptSelector = '[contenteditable="true"][role="textbox"], textarea[placeholder*="Gemini" i], textarea';
const defaultDownloadSelector = 'button[aria-label*="Download" i], button[title*="Download" i], [data-tooltip*="Download" i]';
const modelResponseSelector = 'model-response, [data-message-author-role="model"], .model-response-text';

function nonRetryable(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

const short = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);

async function optionalProductImage(page, url, downloadDir) {
  if (!url) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Existing product image returned HTTP ${response.status}.`);
  const type = response.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) throw new Error("Existing product image URL did not return an image.");
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
  const imagePath = join(downloadDir, `product-reference.${ext}`);
  await writeFile(imagePath, Buffer.from(await response.arrayBuffer()));
  const input = page.locator('input[type="file"]').last();
  if (!await input.count()) throw new Error("Gemini image attachment control was not found.");
  await input.setInputFiles(imagePath);
}

async function selectVideoMode(page, selector, log, jobId) {
  if (selector) {
    await page.locator(selector).first().click({ timeout: 15_000 });
    log("INFO", "gemini_video_mode_selected", { jobId, method: "custom_selector" });
    return true;
  }
  const direct = page.getByRole("button", { name: /create video/i }).or(page.getByText(/^create video$/i)).first();
  if (await direct.count() && await direct.isVisible().catch(() => false)) {
    await direct.click({ timeout: 10_000 });
    log("INFO", "gemini_video_mode_selected", { jobId, method: "direct_create_video" });
    return true;
  }

  const tools = page.getByRole("button", { name: /tools/i }).or(page.getByText(/^tools$/i)).first();
  if (await tools.count() && await tools.isVisible().catch(() => false)) {
    await tools.click({ timeout: 10_000 });
    const menuVideo = page.getByRole("menuitem", { name: /create video|video/i })
      .or(page.getByText(/^create video$/i)).or(page.getByText(/^video$/i)).last();
    const menuVideoVisible = await menuVideo.waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (menuVideoVisible) {
      await menuVideo.click({ timeout: 10_000 });
      log("INFO", "gemini_video_mode_selected", { jobId, method: "tools_menu" });
      return true;
    }
  }
  throw nonRetryable("Gemini's Create video control was not found. The prompt was not submitted as normal chat. Restore Chrome, select Create video manually to verify access, then update GEMINI_VIDEO_MODE_SELECTOR if the Gemini UI changed.");
}

export function looksLikeGeminiTextOnlyAnswer(text) {
  return /cannot directly (?:render|generate|export)|can't directly (?:render|generate|export)|unable to (?:render|generate|export)|production timecode breakdown|optimization for ai video generators|paste into video generator|would you like (?:a|me to)|ffmpeg command|google videofx|typography\s*&\s*audio layering/i.test(text);
}

export async function generateWithGeminiWeb({ job, prompt, config, log = () => {} }) {
  await mkdir(config.downloadDir, { recursive: true });
  log("INFO", "chrome_connecting", { jobId: job.id, cdpUrl: config.cdpUrl });
  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 30_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP connection has no browser context.");
  let page = context.pages().find(item => item.url().includes("gemini.google.com"));
  if (!page) page = await context.newPage();
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60_000 });
  log("INFO", "gemini_page_ready", { jobId: job.id, url: page.url() });
  await selectVideoMode(page, config.videoModeSelector, log, job.id);
  await optionalProductImage(page, job.request?.productImageUrl, config.downloadDir);
  const box = page.locator(config.promptSelector || defaultPromptSelector).first();
  await box.waitFor({ state: "visible", timeout: 60_000 });
  await box.fill(prompt).catch(async () => {
    await box.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(prompt);
  });
  const downloadSelector = config.downloadSelector || defaultDownloadSelector;
  const previousDownloads = await page.locator(downloadSelector).count();
  const responses = page.locator(modelResponseSelector);
  const previousResponses = await responses.count();
  const previousResponseText = previousResponses ? await responses.last().innerText().catch(() => "") : "";
  log("INFO", "gemini_prompt_submitting", { jobId: job.id, promptCharacters: prompt.length, previousDownloads, previousResponses });
  await box.press("Enter");
  const generated = page.locator(downloadSelector);
  const startedAt = Date.now();
  let lastStatusLog = 0;
  let stableText = "";
  let stableTextPolls = 0;
  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    if (await generated.count() > previousDownloads) break;
    if (elapsedMs >= config.generationTimeoutMs) throw new Error(`Gemini video generation timed out after ${Math.round(config.generationTimeoutMs / 60_000)} minutes.`);

    const responseCount = await responses.count();
    const responseText = responseCount > previousResponses
      ? await responses.last().innerText().catch(() => "")
      : (responseCount && await responses.last().innerText().catch(() => "") !== previousResponseText
        ? await responses.last().innerText().catch(() => "") : "");
    const normalized = short(responseText);
    if (normalized && normalized === stableText) stableTextPolls += 1;
    else { stableText = normalized; stableTextPolls = normalized ? 1 : 0; }

    if (elapsedMs >= config.textResponseGraceMs && normalized && (looksLikeGeminiTextOnlyAnswer(normalized) || (normalized.length >= 250 && stableTextPolls >= 2))) {
      log("ERROR", "gemini_text_response_detected", { jobId: job.id, elapsedSeconds: Math.round(elapsedMs / 1000), excerpt: normalized });
      throw nonRetryable(`Gemini returned a text answer instead of generating a video: "${normalized}"`);
    }
    if (elapsedMs - lastStatusLog >= 15_000) {
      lastStatusLog = elapsedMs;
      log("INFO", "gemini_generation_waiting", { jobId: job.id, elapsedSeconds: Math.round(elapsedMs / 1000), responseCharacters: normalized.length });
    }
    await page.waitForTimeout(3000);
  }
  log("INFO", "gemini_download_available", { jobId: job.id, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) });
  const downloadButton = generated.last();
  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    downloadButton.click({ timeout: 30_000 })
  ]).then(([item]) => item);
  const outputPath = join(config.downloadDir, `${job.id}-attempt-${job.generationAttempt}.mp4`);
  await download.saveAs(outputPath);
  log("INFO", "gemini_download_saved", { jobId: job.id, outputPath, suggestedFilename: download.suggestedFilename() });
  return { outputPath, suggestedFilename: download.suggestedFilename() };
}
