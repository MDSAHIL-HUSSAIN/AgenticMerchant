import { addDraftMessage, answerClarification, draftToDesignInput } from "./drafts.js";
import { createDesignJob } from "./orchestrator.js";
import { approveDesigns } from "./approvals.js";
import { applyFeedbackRevision } from "./revisions.js";
import { deliverPreviewPack } from "./handoff.js";
import { getIntegrationResponse, persistIntegrationResponse } from "./state-db.js";
import { publicJob, registerJob, saveJob } from "./job-store.js";

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

export async function processWhatsAppMessage({ metadata = {}, text = "", files = [] }) {
  const messageId = clean(metadata.messageId);
  if (!messageId) throw new Error("messageId is required for WhatsApp idempotency.");
  const key = `whatsapp:message:${messageId}`;
  const previous = getIntegrationResponse(key);
  if (previous) return { ...previous, reused: true };

  let draft;
  if (metadata.productDraftId && metadata.questionId) {
    draft = answerClarification(metadata.productDraftId, {
      questionId: metadata.questionId,
      answer: text,
      facts: metadata.facts,
      assetRoles: metadata.assetRoles
    });
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
      productDraftId: draft.id
    }
  );
  const handoff = await deliverCurrentPreview(job);
  const response = { kind: "design_ready", draft, job: publicJob(job), handoff };
  persistIntegrationResponse(key, response);
  return response;
}

export async function processWhatsAppFeedback(jobId, payload = {}, files = []) {
  const messageId = clean(payload.messageId || payload.idempotencyKey);
  if (!messageId) throw new Error("messageId is required for WhatsApp idempotency.");
  const key = `whatsapp:feedback:${messageId}`;
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
