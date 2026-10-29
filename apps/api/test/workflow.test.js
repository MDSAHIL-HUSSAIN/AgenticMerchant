import test from "node:test";
import assert from "node:assert/strict";
import { validateBrief } from "../src/brief.js";
import { createDeterministicPlan } from "../src/planner.js";
import { renderWithQualityLoop } from "../src/quality.js";
import { storeMedia } from "../src/media-store.js";
import { registerJob } from "../src/job-store.js";
import { applyFeedbackRevision } from "../src/revisions.js";
import { approveDesigns } from "../src/approvals.js";
import { attachAdobePage, claimAdobeJob, completeAdobeJob, createAdobeEditJob } from "../src/adobe-queue.js";
import { deliverPreviewPack } from "../src/handoff.js";
import { config } from "../src/config.js";
import { processWhatsAppMessage } from "../src/whatsapp-integration.js";
import sharp from "sharp";

async function makeJob() {
  const id = crypto.randomUUID();
  const brief = validateBrief({ product: "Cotton Kurti", brand: "Kavya Boutique", features: ["Soft cotton", "Festive detailing"] });
  const designs = createDeterministicPlan(brief).map((design, index) => ({ ...design, id: `design_${index + 1}`, backgroundIndex: -1 }));
  const rendered = await renderWithQualityLoop({ brief, designs, assets: [], backgroundAssets: [] });
  const previewAssets = [];
  for (let index = 0; index < rendered.buffers.length; index += 1) {
    const stored = await storeMedia({
      bytes: rendered.buffers[index], mimeType: "image/png", filename: `${id}-${index}.png`, kind: "DESIGN_PREVIEW",
      metadata: { designJobId: id, designIndex: index, revision: 1 }
    });
    previewAssets.push({ assetId: stored.id, mimeType: stored.mimeType, designIndex: index });
  }
  return registerJob({
    id,
    createdAt: new Date().toISOString(),
    brief,
    assets: [],
    backgroundAssets: [],
    designs: rendered.designs.map((design, index) => ({ ...design, id: `design_${index + 1}` })),
    previewAssets,
    qa: rendered.qa,
    warnings: []
  }, { merchantId: "merchant-test", conversationId: `conversation-${id}` });
}

test("creates an immutable revision from merchant feedback", async () => {
  const job = await makeJob();
  const originalBackground = job.revisions[0].designs[0].background;
  const revised = await applyFeedbackRevision(job.id, {
    action: "EDIT_SELECTED",
    designIds: ["design_1"],
    feedback: "Make the background dark blue and make the headline smaller",
    idempotencyKey: `feedback-${job.id}`
  });
  assert.equal(revised.revisionNumber, 2);
  assert.equal(revised.revisions.length, 2);
  assert.equal(revised.revisions[0].designs[0].background, originalBackground);
  assert.equal(revised.designs[0].background, "#10233F");
  assert.notEqual(revised.previewAssets[0].assetId, job.revisions[0].previewAssets[0].assetId);
});

test("locks an approved revision and creates platform-specific final files", async () => {
  const job = await makeJob();
  const approved = await approveDesigns(job.id, { designIds: ["design_1"], idempotencyKey: `approve-${job.id}`, deliver: false });
  assert.equal(approved.status, "READY_FOR_PUBLISHING");
  assert.deepEqual(approved.approvedDesignIds, ["design_1"]);
  assert.equal(approved.finalAssets.length, 5);
  assert.deepEqual(new Set(approved.finalAssets.map(asset => asset.platform)), new Set(["master", "shopify", "instagram_square", "instagram_portrait", "facebook_feed"]));
  await assert.rejects(() => applyFeedbackRevision(job.id, { feedback: "change it" }), /locked/i);
});

test("round-trips an optional native Adobe edit into a new revision", async () => {
  const job = await makeJob();
  const adobe = createAdobeEditJob(job.id, { designId: "design_1" });
  assert.equal(claimAdobeJob(adobe.id).status, "CLAIMED");
  attachAdobePage(adobe.id, "adobe-page-1");
  const rendition = await import("../src/media-store.js").then(module => module.readMedia(job.previewAssets[0].assetId));
  const completed = await completeAdobeJob(adobe.id, {
    buffer: rendition.bytes,
    mimetype: "image/png",
    originalname: "edited.png"
  }, { adobePageId: "adobe-page-1" });
  assert.equal(completed.adobeJob.status, "COMPLETED");
  assert.equal(completed.designJob.revisionNumber, 2);
  assert.equal(completed.designJob.revisions[1].source, "ADOBE_MANUAL_EDIT");
});

test("delivers preview images as multipart binary files rather than media URLs", async t => {
  const job = await makeJob();
  const originalUrl = config.whatsappHandoffUrl;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    config.whatsappHandoffUrl = originalUrl;
    globalThis.fetch = originalFetch;
  });
  config.whatsappHandoffUrl = "https://whatsapp.internal.test/previews";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, config.whatsappHandoffUrl);
    assert.ok(options.body instanceof FormData);
    const metadata = JSON.parse(options.body.get("metadata"));
    assert.equal(metadata.designJobId, job.id);
    assert.equal(metadata.designs.length, 1);
    assert.ok(options.body.get("preview_1") instanceof Blob);
    assert.equal(options.headers["idempotency-key"], `preview:${job.id}:${job.currentRevisionId}`);
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  const result = await deliverPreviewPack(job);
  assert.equal(result.status, "DELIVERED");
});

test("processes an idempotent WhatsApp image-design request and hands back one preview", async t => {
  const originalUrl = config.whatsappHandoffUrl;
  const originalFetch = globalThis.fetch;
  const messageId = `wamid-${crypto.randomUUID()}`;
  let handoffCount = 0;
  t.after(() => {
    config.whatsappHandoffUrl = originalUrl;
    globalThis.fetch = originalFetch;
  });
  config.whatsappHandoffUrl = "https://whatsapp.internal.test/whatsapp/integrations/agentic/previews";
  globalThis.fetch = async (_url, options) => {
    handoffCount += 1;
    const metadata = JSON.parse(options.body.get("metadata"));
    assert.equal(metadata.merchantId, "919876543210");
    assert.ok(options.body.get("preview_1") instanceof Blob);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const productImage = await sharp({
    create: { width: 240, height: 320, channels: 4, background: { r: 150, g: 78, b: 42, alpha: 1 } }
  }).png().toBuffer();
  const request = {
    metadata: {
      merchantId: "919876543210",
      conversationId: "whatsapp:919876543210",
      messageId,
      productName: "Cotton Kurti",
      brand: "Kavya Boutique",
      mediaRoles: { media: "PRIMARY_PRODUCT" }
    },
    text: "Cotton Kurti by Kavya Boutique, soft cotton festive wear",
    files: [{ fieldname: "media", originalname: "cotton-kurti.png", mimetype: "image/png", buffer: productImage }]
  };
  const first = await processWhatsAppMessage(request);
  const second = await processWhatsAppMessage(request);
  assert.equal(first.kind, "design_ready");
  assert.equal(second.kind, "design_ready");
  assert.equal(second.reused, true);
  assert.equal(handoffCount, 1);
});

test("uploads the single Facebook export to Cloudinary before triggering the unchanged publisher", async t => {
  const job = await makeJob();
  const original = {
    cloudName: config.facebookCloudinaryCloudName,
    apiKey: config.facebookCloudinaryApiKey,
    apiSecret: config.facebookCloudinaryApiSecret,
    publishUrl: config.facebookPublishUrl,
    publishSecret: config.facebookPublishSecret,
    genericUrl: config.publishingHandoffUrl,
    fetch: globalThis.fetch
  };
  t.after(() => {
    config.facebookCloudinaryCloudName = original.cloudName;
    config.facebookCloudinaryApiKey = original.apiKey;
    config.facebookCloudinaryApiSecret = original.apiSecret;
    config.facebookPublishUrl = original.publishUrl;
    config.facebookPublishSecret = original.publishSecret;
    config.publishingHandoffUrl = original.genericUrl;
    globalThis.fetch = original.fetch;
  });
  config.facebookCloudinaryCloudName = "facebook-cloud";
  config.facebookCloudinaryApiKey = "api-key";
  config.facebookCloudinaryApiSecret = "api-secret";
  config.facebookPublishUrl = "https://storebot-facebook.example/api/publish";
  config.facebookPublishSecret = "publish-secret";
  config.publishingHandoffUrl = "";
  let call = 0;
  globalThis.fetch = async (url, options) => {
    call += 1;
    if (call === 1) {
      assert.equal(url, "https://api.cloudinary.com/v1_1/facebook-cloud/image/upload");
      assert.ok(options.body instanceof FormData);
      assert.ok(options.body.get("file") instanceof Blob);
      assert.match(options.body.get("public_id"), /Kavya_Boutique_Cotton_Kurti$/);
      assert.ok(options.body.get("signature"));
      return new Response(JSON.stringify({
        public_id: options.body.get("public_id"),
        secure_url: "https://res.cloudinary.com/facebook-cloud/image/upload/example.png"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(url, config.facebookPublishUrl);
    assert.equal(options.headers.authorization, "Bearer publish-secret");
    return new Response(JSON.stringify({
      success: true,
      result: { facebook_post_id: "post-123", facebook_photo_id: "photo-456" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const approved = await approveDesigns(job.id, { designIds: ["design_1"], idempotencyKey: `facebook-approve-${job.id}` });
  assert.equal(call, 2);
  const delivery = approved.handoffs.find(item => item.type === "PUBLISHING");
  assert.equal(delivery.status, "DELIVERED");
  assert.equal(delivery.deliveries[0].facebookPostId, "post-123");
});
