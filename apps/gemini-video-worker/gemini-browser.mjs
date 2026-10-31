import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const defaultPromptSelector = '[contenteditable="true"][role="textbox"], textarea[placeholder*="Gemini" i], textarea';

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

async function selectVideoMode(page, selector) {
  if (selector) {
    await page.locator(selector).first().click({ timeout: 15_000 });
    return;
  }
  const candidate = page.getByRole("button", { name: /create video|video/i }).or(page.getByText(/^video$/i)).first();
  if (await candidate.count()) await candidate.click({ timeout: 5000 }).catch(() => {});
}

export async function generateWithGeminiWeb({ job, prompt, config }) {
  await mkdir(config.downloadDir, { recursive: true });
  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: 30_000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP connection has no browser context.");
  let page = context.pages().find(item => item.url().includes("gemini.google.com"));
  if (!page) page = await context.newPage();
  await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await selectVideoMode(page, config.videoModeSelector);
  await optionalProductImage(page, job.request?.productImageUrl, config.downloadDir);
  const box = page.locator(config.promptSelector || defaultPromptSelector).first();
  await box.waitFor({ state: "visible", timeout: 60_000 });
  await box.fill(prompt).catch(async () => {
    await box.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(prompt);
  });
  const previousDownloads = await page.locator('button[aria-label*="Download" i], button[title*="Download" i], [data-tooltip*="Download" i]').count();
  await box.press("Enter");
  const custom = config.downloadSelector ? page.locator(config.downloadSelector) : null;
  const generated = custom || page.locator('button[aria-label*="Download" i], button[title*="Download" i], [data-tooltip*="Download" i]');
  await page.waitForFunction(({ selector, previous }) => document.querySelectorAll(selector).length > previous,
    { selector: config.downloadSelector || 'button[aria-label*="Download" i], button[title*="Download" i], [data-tooltip*="Download" i]', previous: previousDownloads },
    { timeout: config.generationTimeoutMs, polling: 3000 });
  const downloadButton = generated.last();
  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    downloadButton.click({ timeout: 30_000 })
  ]).then(([item]) => item);
  const outputPath = join(config.downloadDir, `${job.id}-attempt-${job.generationAttempt}.mp4`);
  await download.saveAs(outputPath);
  return { outputPath, suggestedFilename: download.suggestedFilename() };
}
