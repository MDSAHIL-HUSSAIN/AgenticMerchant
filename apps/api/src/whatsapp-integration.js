import { addDraftMessage, answerClarification, draftToDesignInput } from "./drafts.js";
import { createDesignJob } from "./orchestrator.js";
import { approveDesigns } from "./approvals.js";
import { applyFeedbackRevision } from "./revisions.js";
import { deliverPreviewPack } from "./handoff.js";
import { getIntegrationResponse, persistIntegrationResponse } from "./state-db.js";
import { getJob, publicJob, registerJob, saveJob } from "./job-store.js";

const clean = value => String(value || "").trim();

function firstQuestion(draft) {
  const question = draft.questions?.[0];
  return question ? {
    id: question.id,
    field: question.field,
    prompt: question.question || question.prompt,
    options: question.choices || question.options || []
  } : null;
}

async function deliverCurrentPreview(job) {
  const existing = job.handoffs.find(item => item.type === "WHATSAPP_PREVIEW" && item.revisionId === job.currentRevisionId && item.status === "DELIVERED");
  if (existing) return { ...existing, reused: true };
  const result = await deliverPreviewPack(job);
  job.handoffs.push({ type: "WHATSAPP_PREVIEW", revisionId: job.currentRevisionId, ...result });
  saveJob(job);
  return result;
}

async function processIntegrationMessage(sourceChannel, { metadata = {}, text = "", files = [] }) {
  metadata = { ...metadata, sourceChannel };
  const messageId = clean(metadata.messageId);
  if (!messageId) throw new Error("messageId is required for integration idempotency.");
  const key = `${sourceChannel}:message:${messageId}`;
  const previous = getIntegrationResponse(key);
  if (previous) return { ...previous, reused: true };

  let draft;
  if (metadata.productDraftId && metadata.questionId) {
    try {
      draft = answerClarification(metadata.productDraftId, {
        questionId: metadata.questionId,
        answer: text,
        facts: metadata.facts,
        assetRoles: metadata.assetRoles
      });
    } catch (error) {
      if (error.message !== "Product draft not found.") throw error;
      // Render's local Agentic state can be replaced during deployment while
      // the WhatsApp database still remembers the previous clarification.
      // Rebuild the draft from the retried message and media instead of
      // permanently retrying a draft ID that can no longer exist.
      const freshMetadata = { ...metadata };
      delete freshMetadata.productDraftId;
      delete freshMetadata.questionId;
      console.warn(JSON.stringify({
        event: `${sourceChannel}.draft.recovered`,
        messageId,
        expiredDraftId: metadata.productDraftId,
        fileCount: files.length
      }));
      draft = await addDraftMessage({ metadata: freshMetadata, text, files });
    }
  } else {
    draft = await addDraftMessage({ metadata, text, files });
  }

  if (draft.status === "NEEDS_CLARIFICATION") {
    const response = { kind: "clarification_required", draft, question: firstQuestion(draft) };
    persistIntegrationResponse(key, response);
    return response;
  }

  const input = draftToDesignInput(draft.id);
  const job = registerJob(
    await createDesignJob(input.brief, {
      productAssetIds: input.productAssetIds,
      referenceAssetIds: input.referenceAssetIds
    }),
    {
      merchantId: input.draft.merchantId,
      conversationId: input.draft.conversationId,
      productId: input.draft.productId,
      productDraftId: draft.id,
      sourceChannel: input.draft.sourceChannel,
      targetChannels: input.draft.targetChannels
    }
  );
  const handoff = await deliverCurrentPreview(job);
  const response = { kind: "design_ready", draft, job: publicJob(job), handoff };
  persistIntegrationResponse(key, response);
  return response;
}

async function processIntegrationFeedback(sourceChannel, jobId, payload = {}, files = []) {
  const existingJob = getJob(jobId);
  const ownerChannel = existingJob.sourceChannel || "whatsapp";
  if (ownerChannel !== sourceChannel) throw new Error(`This design job belongs to the ${ownerChannel} integration.`);
  const messageId = clean(payload.messageId || payload.idempotencyKey);
  if (!messageId) throw new Error("messageId is required for integration idempotency.");
  const key = `${sourceChannel}:feedback:${messageId}`;
  const previous = getIntegrationResponse(key);
  if (previous) return { ...previous, reused: true };
  const action = clean(payload.action || "EDIT_SELECTED").toUpperCase();
  let job;
  let handoff = null;
  if (action === "APPROVE_ALL" || action === "APPROVE_SELECTED") {
    job = await approveDesigns(jobId, {
      designIds: action === "APPROVE_SELECTED" ? payload.designIds : [],
      idempotencyKey: messageId,
      deliver: payload.deliver === undefined ? true : Boolean(payload.deliver)
    });
  } else {
    job = await applyFeedbackRevision(jobId, { ...payload, messageId }, files);
    handoff = await deliverCurrentPreview(job);
  }
  const response = { kind: action.startsWith("APPROVE") ? "approved" : "revision_ready", job: publicJob(job), handoff };
  persistIntegrationResponse(key, response);
  return response;
}

export const processWhatsAppMessage = input => processIntegrationMessage("whatsapp", input);
export const processDashboardMessage = input => processIntegrationMessage("dashboard", input);
export const processWhatsAppFeedback = (jobId, payload, files) => processIntegrationFeedback("whatsapp", jobId, payload, files);
export const processDashboardFeedback = (jobId, payload, files) => processIntegrationFeedback("dashboard", jobId, payload, files);
