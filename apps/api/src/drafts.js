import { classifyUpload, buildClarifications, extractBriefFacts, toLegacyBrief } from "./multimodal.js";
import { storeMedia, updateMediaRecord } from "./media-store.js";
import { config } from "./config.js";
import { classifyGeminiUploads } from "./providers.js";
import { transcribeStoredAudio } from "./transcription.js";
import { loadDrafts, persistDraft } from "./state-db.js";

const drafts = new Map(loadDrafts().map(draft => [draft.id, draft]));
const clean = value => String(value || "").trim();
const supportedChannels = new Set(["instagram", "facebook", "shopify"]);
const defaultImageChannels = ["instagram", "facebook", "shopify"];

function normalizeTargetChannels(value, fallback = defaultImageChannels) {
  if (value === undefined || value === null || value === "") return [...fallback];
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch { parsed = value.split(","); }
  }
  if (!Array.isArray(parsed)) return [...fallback];
  return [...new Set(parsed.map(item => clean(item).toLowerCase()).filter(item => supportedChannels.has(item)))];
}

function parseObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    throw new Error("metadata must be valid JSON.");
  }
}

function publicDraft(draft) {
  return {
    id: draft.id,
    merchantId: draft.merchantId,
    conversationId: draft.conversationId,
    sourceChannel: draft.sourceChannel || "whatsapp",
    targetChannels: [...(draft.targetChannels || defaultImageChannels)],
    productId: draft.productId,
    status: draft.status,
    facts: { ...draft.facts },
    media: draft.media.map(item => ({ ...item })),
    questions: draft.questions.map(item => ({ ...item })),
    messageCount: draft.messages.length,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt
  };
}

function recompute(draft) {
  const mergedMetadata = Object.assign({}, ...draft.messages.map(message => message.metadata));
  const text = draft.messages.map(message => message.text).filter(Boolean).join(" ");
  const transcripts = draft.media.map(item => item.transcript).filter(Boolean);
  draft.facts = extractBriefFacts({ metadata: mergedMetadata, text, transcripts });
  draft.questions = buildClarifications({ facts: draft.facts, media: draft.media, targetChannels: draft.targetChannels });
  draft.status = draft.questions.length ? "NEEDS_CLARIFICATION" : "BRIEF_READY";
  draft.updatedAt = new Date().toISOString();
}

export async function addDraftMessage({ metadata: rawMetadata, text, files = [] }) {
  const metadata = parseObject(rawMetadata);
  const merchantId = clean(metadata.merchantId);
  const conversationId = clean(metadata.conversationId);
  if (!merchantId) throw new Error("merchantId is required.");
  if (!conversationId) throw new Error("conversationId is required.");
  const id = clean(metadata.productDraftId) || `draft_${crypto.randomUUID()}`;
  const existing = drafts.get(id);
  if (existing && (existing.merchantId !== merchantId || existing.conversationId !== conversationId)) {
    throw new Error("The product draft belongs to another conversation.");
  }
  const now = new Date().toISOString();
  const draft = existing || {
    id,
    merchantId,
    conversationId,
    sourceChannel: clean(metadata.sourceChannel).toLowerCase() || (conversationId.startsWith("dashboard:") ? "dashboard" : "whatsapp"),
    targetChannels: normalizeTargetChannels(metadata.targetChannels),
    productId: clean(metadata.productId),
    status: "COLLECTING_INPUT",
    messages: [],
    media: [],
    facts: {},
    questions: [],
    createdAt: now,
    updatedAt: now
  };
  if (metadata.targetChannels !== undefined) draft.targetChannels = normalizeTargetChannels(metadata.targetChannels, draft.targetChannels);
  const mediaRoles = parseObject(metadata.mediaRoles);
  const transcripts = parseObject(metadata.audioTranscripts);
  let visualAnalysis = null;
  if (config.autonomousMediaAnalysis && config.geminiApiKey && files.some(file => String(file.mimetype || "").startsWith("image/"))) {
    try {
      visualAnalysis = await classifyGeminiUploads({ files, text: text || metadata.text, metadata });
      const visualFacts = visualAnalysis?.visualFacts || {};
      for (const [key, value] of Object.entries(visualFacts)) {
        if ((metadata[key] === undefined || metadata[key] === "") && value !== undefined && value !== "") metadata[key] = value;
      }
    } catch (error) {
      metadata.mediaAnalysisWarning = error.message;
    }
  }
  const addedMedia = [];
  for (const file of files) {
    const classification = classifyUpload(file, mediaRoles);
    const imageIndex = files.filter(candidate => String(candidate.mimetype || "").startsWith("image/")).indexOf(file);
    const visual = imageIndex >= 0 ? visualAnalysis?.images?.find(item => Number(item.index) === imageIndex) : null;
    if (visual?.role) {
      classification.role = String(visual.role).toUpperCase();
      classification.confidence = Math.max(0, Math.min(1, Number(visual.confidence) || 0));
      classification.description = String(visual.description || "");
    }
    if (classification.mediaType === "other") throw new Error(`Unsupported upload type: ${classification.mimeType}`);
    let transcript = clean(transcripts[file.fieldname] || transcripts[file.originalname]);
    const stored = await storeMedia({
      bytes: file.buffer,
      mimeType: classification.mimeType,
      filename: classification.filename,
      kind: classification.role,
      metadata: { merchantId, conversationId, productDraftId: id }
    });
    if (classification.mediaType === "audio" && !transcript && config.localWhisperEnabled) {
      try {
        transcript = await transcribeStoredAudio(stored.id);
      } catch (error) {
        classification.transcriptionWarning = error.message;
      }
    }
    addedMedia.push({ ...classification, assetId: stored.id, transcript });
  }
  draft.messages.push({
    id: clean(metadata.messageId) || `message_${crypto.randomUUID()}`,
    text: clean(text || metadata.text),
    metadata,
    assetIds: addedMedia.map(item => item.assetId),
    createdAt: now
  });
  draft.media.push(...addedMedia);
  recompute(draft);
  drafts.set(id, draft);
  persistDraft(draft);
  return publicDraft(draft);
}

export function getDraft(id) {
  const draft = drafts.get(String(id));
  if (!draft) throw new Error("Product draft not found.");
  return publicDraft(draft);
}

export function getDraftInternal(id) {
  const draft = drafts.get(String(id));
  if (!draft) throw new Error("Product draft not found.");
  return draft;
}

export function answerClarification(id, payload = {}) {
  const draft = getDraftInternal(id);
  const question = draft.questions.find(item => item.id === payload.questionId) || draft.questions[0];
  if (!question) throw new Error("This draft has no pending clarification.");
  const answer = clean(payload.answer);
  if (!answer && !payload.assetRoles && !payload.facts) throw new Error("A clarification answer is required.");
  if (payload.assetRoles && typeof payload.assetRoles === "object") {
    for (const [assetId, role] of Object.entries(payload.assetRoles)) {
      const item = draft.media.find(media => media.assetId === assetId);
      if (!item) continue;
      item.role = String(role).toUpperCase();
      item.confidence = 1;
      updateMediaRecord(assetId, { kind: item.role });
    }
  } else if (question.field === "imageRoles" && question.assetIds?.length === 1 && /^(product|reference)$/i.test(answer)) {
    const item = draft.media.find(media => media.assetId === question.assetIds[0]);
    if (item) {
      item.role = /^product$/i.test(answer) ? "PRIMARY_PRODUCT" : "STYLE_REFERENCE";
      item.confidence = 1;
      updateMediaRecord(item.assetId, { kind: item.role });
    }
  }
  const factPatch = { ...(payload.facts || {}) };
  if (question.field === "productName" && answer) factPatch.productName = answer;
  if (question.field === "cost" && answer) {
    const cost = Number(String(answer).replace(/[^0-9.]/g, ""));
    if (!(cost > 0)) throw new Error("Enter a valid product cost greater than zero.");
    factPatch.cost = cost;
  }
  if (question.field === "audioTranscript" && answer) {
    for (const assetId of question.assetIds || []) {
      const item = draft.media.find(media => media.assetId === assetId);
      if (item) item.transcript = answer;
    }
  }
  draft.messages.push({
    id: `clarification_${crypto.randomUUID()}`,
    text: answer,
    metadata: factPatch,
    assetIds: [],
    createdAt: new Date().toISOString()
  });
  recompute(draft);
  persistDraft(draft);
  return publicDraft(draft);
}

export function submitDraft(id) {
  const draft = getDraftInternal(id);
  recompute(draft);
  if (draft.questions.length) return publicDraft(draft);
  draft.status = "BRIEF_READY";
  persistDraft(draft);
  return publicDraft(draft);
}

export function draftToDesignInput(id) {
  const draft = getDraftInternal(id);
  recompute(draft);
  if (draft.questions.length) throw new Error("The product draft needs clarification before design generation.");
  const productAssetIds = draft.media
    .filter(item => ["PRIMARY_PRODUCT", "PRODUCT_DETAIL", "PRODUCT_VARIANT"].includes(item.role))
    .map(item => item.assetId);
  return {
    brief: toLegacyBrief(draft.facts),
    productAssetIds,
    referenceAssetIds: draft.media.filter(item => ["STYLE_REFERENCE", "BACKGROUND_REFERENCE"].includes(item.role)).map(item => item.assetId),
    draft: publicDraft(draft),
    commerce: {
      cost: draft.facts.cost,
      sku: draft.facts.sku,
      vendor: draft.facts.brand,
      productType: draft.facts.category
    }
  };
}
