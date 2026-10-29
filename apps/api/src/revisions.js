import { config } from "./config.js";
import { classifyUpload } from "./multimodal.js";
import { getJob, hasProcessedKey, rememberProcessedKey, saveJob } from "./job-store.js";
import { storeMedia } from "./media-store.js";
import { normalizePlan } from "./planner.js";
import { renderWithQualityLoop } from "./quality.js";
import { transcribeStoredAudio } from "./transcription.js";
import { generateGeminiRevisionPlan } from "./providers.js";

const colorNames = {
  black: "#111111", white: "#F8F8F5", cream: "#F3E4CC", beige: "#D8C3A5", navy: "#10233F",
  "dark blue": "#10233F", blue: "#2457D6", maroon: "#5A1730", red: "#C52A35", orange: "#F0642E",
  yellow: "#F4C542", green: "#2E6B4F", pink: "#E68AA7", purple: "#6041A5", grey: "#777A80", gray: "#777A80"
};
const layouts = ["hero-right", "hero-left", "split", "centered", "detail", "closing"];
const motifs = ["none", "contour", "precision-grid", "motion-lines", "material-dots"];

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function parseMultipartMetadata(body = {}) {
  if (!body.metadata) return body;
  try {
    return { ...body, ...JSON.parse(body.metadata) };
  } catch {
    throw new Error("Feedback metadata must be valid JSON.");
  }
}

function list(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try { return JSON.parse(value).map(String); } catch { /* use comma parsing */ }
  }
  return String(value).split(",").map(item => item.trim()).filter(Boolean);
}

function requestedColor(feedback) {
  const hex = feedback.match(/#[0-9a-f]{6}\b/i)?.[0];
  if (hex) return hex.toUpperCase();
  const lower = feedback.toLowerCase();
  return Object.entries(colorNames).sort((a, b) => b[0].length - a[0].length).find(([name]) => lower.includes(name))?.[1] || "";
}

function applyStructuredChanges(design, changes = {}) {
  const result = structuredClone(design);
  if (changes.background && /^#[0-9a-f]{6}$/i.test(changes.background)) result.background = changes.background;
  if (changes.accent && /^#[0-9a-f]{6}$/i.test(changes.accent)) result.accent = changes.accent;
  if (changes.textColor && /^#[0-9a-f]{6}$/i.test(changes.textColor)) result.textColor = changes.textColor;
  if (changes.headline !== undefined) result.headline = clean(changes.headline);
  if (changes.subheadline !== undefined) result.subheadline = clean(changes.subheadline);
  if (changes.eyebrow !== undefined) result.eyebrow = clean(changes.eyebrow);
  if (changes.motif && motifs.includes(changes.motif)) result.motif = changes.motif;
  if (changes.layout && layouts.includes(changes.layout)) result.layout = changes.layout;
  if (Number.isInteger(Number(changes.imageIndex))) result.imageIndex = Number(changes.imageIndex);
  if (changes.composition && typeof changes.composition === "object") result.composition = { ...result.composition, ...changes.composition };
  return result;
}

function applyNaturalLanguage(design, feedback, newImageIndex) {
  const result = structuredClone(design);
  const lower = feedback.toLowerCase();
  const background = requestedColor(feedback);
  if (background && /background|backdrop|colour|color|palette/.test(lower)) result.background = background;
  if (/minimal|cleaner|less decoration|remove decoration/.test(lower)) result.motif = "none";
  if (/premium|luxury|elegant/.test(lower)) {
    result.background = background || "#171219";
    result.textColor = "#FFF8EC";
    result.accent = "#D9B46D";
    result.motif = result.motif === "motion-lines" ? "contour" : result.motif;
  }
  if (/headline.*smaller|smaller headline|reduce.*headline/.test(lower)) result.composition.headlineSize = Math.max(42, result.composition.headlineSize - 12);
  if (/headline.*larger|bigger headline|increase.*headline/.test(lower)) result.composition.headlineSize = Math.min(82, result.composition.headlineSize + 10);
  if (/move (?:the )?product (?:to the )?left/.test(lower)) result.composition.productX = 64;
  if (/move (?:the )?product (?:to the )?right/.test(lower)) result.composition.productX = Math.max(560, 1080 - 64 - result.composition.productWidth);
  if (/move (?:the )?(?:text|headline) (?:to the )?left/.test(lower)) result.composition.textX = 64;
  if (/move (?:the )?(?:text|headline) (?:to the )?right/.test(lower)) result.composition.textX = 600;
  if (/remove (?:the )?(?:description|subheadline|subtitle)/.test(lower)) result.subheadline = "";
  const headline = feedback.match(/(?:headline|title)\s*(?:to|as|:)\s*["“]?([^"”]+)["”]?/i)?.[1];
  if (headline) result.headline = clean(headline).slice(0, 52);
  if (newImageIndex >= 0 && (!feedback || /use|replace|change|photo|image|picture/.test(lower))) result.imageIndex = newImageIndex;
  const ordinal = lower.match(/(?:use|choose|with)\s+(?:the\s+)?(first|second|third|[1-3])\s+(?:photo|image|picture)/)?.[1];
  if (ordinal) result.imageIndex = ({ first: 0, second: 1, third: 2 }[ordinal] ?? Number(ordinal) - 1);
  return result;
}

function regenerateDesign(design, index, assetCount) {
  const result = structuredClone(design);
  const currentLayout = Math.max(0, layouts.indexOf(result.layout));
  result.layout = layouts[(currentLayout + 2 + index) % layouts.length];
  result.motif = motifs[(motifs.indexOf(result.motif) + 2 + index) % motifs.length];
  result.imageIndex = (Number(result.imageIndex) + 1 + index) % Math.max(1, assetCount);
  [result.background, result.textColor] = [result.textColor, result.background];
  result.accent = index % 2 ? "#FF7A59" : "#50D6C1";
  result.eyebrow = index % 2 ? "A NEW DIRECTION" : "REIMAGINED";
  return result;
}

async function storeFeedbackFiles(job, files, payload) {
  const mediaRoles = payload.mediaRoles && typeof payload.mediaRoles === "object" ? payload.mediaRoles : {};
  const transcripts = payload.audioTranscripts && typeof payload.audioTranscripts === "object" ? payload.audioTranscripts : {};
  const stored = [];
  for (const file of files) {
    const classification = classifyUpload(file, mediaRoles);
    let transcript = clean(transcripts[file.fieldname] || transcripts[file.originalname]);
    const asset = await storeMedia({
      bytes: file.buffer,
      mimeType: file.mimetype,
      filename: file.originalname,
      kind: classification.role === "UNCERTAIN" && classification.mediaType === "image" ? "FEEDBACK_IMAGE" : classification.role,
      metadata: { designJobId: job.id, revisionId: job.currentRevisionId }
    });
    if (classification.mediaType === "audio" && !transcript && config.localWhisperEnabled) {
      try { transcript = await transcribeStoredAudio(asset.id); } catch { /* clarification remains in feedback text */ }
    }
    stored.push({ ...classification, assetId: asset.id, transcript });
  }
  return stored;
}

async function saveRevisionPreviews(job, result, revisionNumber) {
  const previewAssets = [];
  for (let index = 0; index < result.buffers.length; index += 1) {
    const stored = await storeMedia({
      bytes: result.buffers[index],
      mimeType: "image/png",
      filename: `${job.id}-revision-${revisionNumber}-preview-${index + 1}.png`,
      kind: "DESIGN_PREVIEW",
      metadata: { designJobId: job.id, designIndex: index, revision: revisionNumber }
    });
    previewAssets.push({ assetId: stored.id, mimeType: stored.mimeType, byteLength: stored.byteLength, designIndex: index });
  }
  return previewAssets;
}

export async function applyFeedbackRevision(jobId, rawPayload = {}, files = []) {
  const payload = parseMultipartMetadata(rawPayload);
  const job = getJob(jobId);
  if (["APPROVED", "READY_FOR_PUBLISHING"].includes(job.status)) throw new Error("The approved revision is locked. Create a new design job to change it.");
  const idempotencyKey = payload.idempotencyKey || payload.messageId;
  if (hasProcessedKey(job, idempotencyKey)) return job;
  const uploaded = await storeFeedbackFiles(job, files, payload);
  const transcript = uploaded.map(item => item.transcript).filter(Boolean).join(" ");
  const feedback = clean([payload.feedback || payload.text, transcript].filter(Boolean).join(" "));
  const action = String(payload.action || "EDIT_SELECTED").toUpperCase();
  const requestedIds = list(payload.designIds);
  const targets = new Set(requestedIds.length ? requestedIds : job.designs.map(design => design.id));
  const productUploads = uploaded.filter(item => item.mediaType === "image" && !["STYLE_REFERENCE", "BACKGROUND_REFERENCE", "ANNOTATED_FEEDBACK", "BRAND_LOGO"].includes(item.role));
  for (const upload of productUploads) {
    job.assets.push({ assetId: upload.assetId, title: upload.filename, source: "Merchant revision upload", width: 0, height: 0, score: 100 });
  }
  const newImageIndex = productUploads.length ? job.assets.length - 1 : -1;
  const changes = payload.changes && typeof payload.changes === "object" ? payload.changes : {};
  if (!action.startsWith("REJECT") && !feedback && newImageIndex < 0 && !Object.keys(changes).length) {
    throw new Error("The edit request contained no usable text, transcript, replacement product image, or structured changes.");
  }
  let aiRevision = null;
  if (!action.startsWith("REJECT") && feedback && config.autonomousRevisionAi && config.geminiApiKey) {
    try {
      aiRevision = await generateGeminiRevisionPlan({
        brief: job.brief,
        designs: job.designs,
        feedback,
        targetDesignIds: [...targets],
        assetCount: job.assets.length
      });
    } catch (error) {
      job.warnings.push(`AI revision planner used deterministic fallback: ${error.message}`);
    }
  }
  let revised = aiRevision?.designs?.length === job.designs.length ? aiRevision.designs : job.designs.map((design, index) => {
    if (!targets.has(design.id)) return structuredClone(design);
    if (action.startsWith("REJECT")) return regenerateDesign(design, index, job.assets.length);
    return applyNaturalLanguage(design, feedback, newImageIndex);
  });
  revised = revised.map((design, index) => {
    const original = job.designs[index];
    if (!targets.has(original.id)) return structuredClone(original);
    return applyStructuredChanges(design, changes[original.id] || changes);
  });
  revised = normalizePlan({ designs: revised }, job.brief, Math.max(1, job.assets.length));
  revised = revised.map((design, index) => ({ ...design, id: job.designs[index]?.id || `design_${index + 1}` }));
  const result = await renderWithQualityLoop({ brief: job.brief, designs: revised, assets: job.assets, backgroundAssets: job.backgroundAssets || [] });
  const revisionNumber = job.revisionNumber + 1;
  const previewAssets = await saveRevisionPreviews(job, result, revisionNumber);
  const revision = {
    id: `revision_${crypto.randomUUID()}`,
    number: revisionNumber,
    source: action.startsWith("REJECT") ? "REJECTION_REGENERATION" : "MERCHANT_FEEDBACK",
    designs: result.designs.map((design, index) => ({ ...design, id: revised[index].id })),
    previewAssets,
    qa: result.qa,
    feedback: { action, text: feedback, targetDesignIds: [...targets], uploadedAssetIds: uploaded.map(item => item.assetId) },
    createdAt: new Date().toISOString()
  };
  job.designs = revision.designs;
  job.previewAssets = previewAssets;
  job.qa = result.qa;
  job.currentRevisionId = revision.id;
  job.revisionNumber = revisionNumber;
  job.revisions.push(revision);
  job.status = "AWAITING_APPROVAL";
  rememberProcessedKey(job, idempotencyKey);
  return saveJob(job);
}

export async function addAdobeRevision(jobId, { designId, assetId, adobePageId = "", feedback = "Manual Adobe edit" }) {
  const job = getJob(jobId);
  if (["APPROVED", "READY_FOR_PUBLISHING"].includes(job.status)) throw new Error("The approved revision is locked.");
  const designIndex = job.designs.findIndex(design => design.id === designId);
  if (designIndex < 0) throw new Error("Design not found.");
  const revisionNumber = job.revisionNumber + 1;
  const previewAssets = job.previewAssets.map(asset => ({ ...asset }));
  previewAssets[designIndex] = { assetId, mimeType: "image/png", designIndex, source: "ADOBE_MANUAL_EDIT" };
  const revision = {
    id: `revision_${crypto.randomUUID()}`,
    number: revisionNumber,
    source: "ADOBE_MANUAL_EDIT",
    designs: structuredClone(job.designs),
    previewAssets,
    qa: null,
    feedback: { action: "EDIT_MANUALLY", text: feedback, targetDesignIds: [designId], adobePageId },
    createdAt: new Date().toISOString()
  };
  job.previewAssets = previewAssets;
  job.currentRevisionId = revision.id;
  job.revisionNumber = revisionNumber;
  job.revisions.push(revision);
  job.status = "AWAITING_APPROVAL";
  return saveJob(job);
}
