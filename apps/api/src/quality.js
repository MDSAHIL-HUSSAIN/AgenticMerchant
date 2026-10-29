import sharp from "sharp";
import { config } from "./config.js";
import { normalizePlan } from "./planner.js";
import { critiqueGeminiDesigns } from "./providers.js";
import { renderPack } from "./renderer.js";

const SAFE = 64;
const LIMIT = 1080;

function boundsIssue(name, x, y, width, height) {
  return x < SAFE || y < SAFE || x + width > LIMIT - SAFE || y + height > 950
    ? { severity: "high", code: `${name.toUpperCase()}_OUT_OF_BOUNDS`, element: name }
    : null;
}

function overlapRatio(c) {
  const text = { x: c.textX, y: c.textY, w: c.textWidth, h: 360 };
  const product = { x: c.productX, y: c.productY, w: c.productWidth, h: c.productHeight };
  const width = Math.max(0, Math.min(text.x + text.w, product.x + product.w) - Math.max(text.x, product.x));
  const height = Math.max(0, Math.min(text.y + text.h, product.y + product.h) - Math.max(text.y, product.y));
  return (width * height) / Math.max(1, Math.min(text.w * text.h, product.w * product.h));
}

export async function inspectDesign(design, buffer) {
  const c = design.composition;
  const issues = [
    boundsIssue("text", c.textX, c.textY, c.textWidth, 360),
    boundsIssue("product", c.productX, c.productY, c.productWidth, c.productHeight)
  ].filter(Boolean);
  const estimatedHeadlineChars = Math.max(8, Math.floor(c.textWidth / (c.headlineSize * .56))) * 3;
  if (design.headline.length > estimatedHeadlineChars) issues.push({ severity: "high", code: "HEADLINE_OVERFLOW", element: "headline" });
  if (overlapRatio(c) > .18) issues.push({ severity: "high", code: "TEXT_PRODUCT_COLLISION", element: "composition" });
  const stats = await sharp(buffer).stats();
  const channelSpread = Math.max(...stats.channels.slice(0, 3).map(item => item.stdev));
  if (channelSpread < 5) issues.push({ severity: "medium", code: "VISUALLY_EMPTY", element: "canvas" });
  return {
    passed: !issues.some(issue => issue.severity === "high"),
    score: Math.max(0, 100 - issues.reduce((total, issue) => total + (issue.severity === "high" ? 24 : 10), 0)),
    issues
  };
}

function repairDesign(design, review) {
  const fixed = structuredClone(design);
  for (const issue of review.issues) {
    if (issue.code === "HEADLINE_OVERFLOW") fixed.composition.headlineSize = Math.max(42, fixed.composition.headlineSize - 10);
    if (issue.code === "TEXT_PRODUCT_COLLISION") {
      const textOnLeft = fixed.composition.textX < 540;
      fixed.composition.productX = textOnLeft ? 560 : 64;
      fixed.composition.productWidth = 456;
      fixed.composition.textX = textOnLeft ? 64 : 600;
      fixed.composition.textWidth = 416;
    }
    if (issue.code === "TEXT_OUT_OF_BOUNDS") {
      fixed.composition.textX = Math.min(600, Math.max(SAFE, fixed.composition.textX));
      fixed.composition.textY = Math.min(590, Math.max(SAFE, fixed.composition.textY));
      fixed.composition.textWidth = Math.min(LIMIT - SAFE - fixed.composition.textX, fixed.composition.textWidth);
    }
    if (issue.code === "PRODUCT_OUT_OF_BOUNDS") {
      fixed.composition.productX = Math.max(SAFE, fixed.composition.productX);
      fixed.composition.productY = Math.max(SAFE, fixed.composition.productY);
      fixed.composition.productWidth = Math.min(LIMIT - SAFE - fixed.composition.productX, fixed.composition.productWidth);
      fixed.composition.productHeight = Math.min(950 - fixed.composition.productY, fixed.composition.productHeight);
    }
  }
  return fixed;
}

function packDiversityIssues(designs) {
  if (designs.length < 2) return [];
  const signatures = designs.map(item => `${item.layout}:${item.imageIndex}:${item.motif}`);
  const unique = new Set(signatures).size;
  return unique >= 4 ? [] : [{ severity: "medium", code: "REPETITIVE_PACK", element: "pack" }];
}

export async function renderWithQualityLoop({ brief, designs, assets, backgroundAssets }) {
  let current = normalizePlan({ designs }, brief, Math.max(1, assets.length));
  let buffers = [];
  let reviews = [];
  let repairs = 0;
  for (let attempt = 0; attempt <= config.maxAutomaticRepairs; attempt += 1) {
    buffers = await renderPack({ brief, designs: current, assets, backgroundAssets });
    reviews = await Promise.all(current.map((design, index) => inspectDesign(design, buffers[index])));
    if (reviews.every(review => review.passed)) break;
    if (attempt === config.maxAutomaticRepairs) break;
    current = normalizePlan({ designs: current.map((design, index) => repairDesign(design, reviews[index])) }, brief, Math.max(1, assets.length));
    repairs += 1;
  }

  let visionReview = null;
  if (config.autonomousVisionQa && config.geminiApiKey && !config.demoMode) {
    const previews = buffers.map(buffer => `data:image/png;base64,${buffer.toString("base64")}`);
    visionReview = await critiqueGeminiDesigns({ brief, designs: current, previews });
    if (visionReview?.designs) {
      current = normalizePlan(visionReview, brief, Math.max(1, assets.length));
      buffers = await renderPack({ brief, designs: current, assets, backgroundAssets });
      reviews = await Promise.all(current.map((design, index) => inspectDesign(design, buffers[index])));
    }
  }

  const diversityIssues = packDiversityIssues(current);
  return {
    designs: current,
    buffers,
    qa: {
      passed: reviews.every(review => review.passed),
      repairs,
      scores: reviews.map(review => review.score),
      issues: [...reviews.flatMap((review, index) => review.issues.map(issue => ({ designIndex: index, ...issue }))), ...diversityIssues],
      vision: visionReview ? { summary: visionReview.summary || "", scores: visionReview.scores || {} } : null
    }
  };
}
