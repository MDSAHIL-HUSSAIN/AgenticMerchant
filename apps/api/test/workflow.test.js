import test from "node:test";
import assert from "node:assert/strict";
import { validateBrief } from "../src/brief.js";
import { createDeterministicPlan } from "../src/planner.js";
import { renderWithQualityLoop } from "../src/quality.js";
import { readMedia, storeMedia } from "../src/media-store.js";
import { createDesignJob } from "../src/orchestrator.js";
import { registerJob } from "../src/job-store.js";
import { applyFeedbackRevision } from "../src/revisions.js";
import { approveDesigns } from "../src/approvals.js";
import { attachAdobePage, claimAdobeJob, completeAdobeJob, createAdobeEditJob } from "../src/adobe-queue.js";
import { deliverPreviewPack } from "../src/handoff.js";
import { config } from "../src/config.js";
import { processWhatsAppFeedback, processWhatsAppMessage } from "../src/whatsapp-integration.js";
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

test("stores one transparent product cutout before rendering a live image design", async t => {
  const original = {
    demoMode: config.demoMode,
    removeBgApiKey: config.removeBgApiKey,
    removeBgSize: config.removeBgSize,
    geminiApiKey: config.geminiApiKey,
    pixabayApiKey: config.pixabayApiKey,
    cloudflareAccountId: config.cloudflareAccountId,
    cloudflareApiToken: config.cloudflareApiToken,
    fetch: globalThis.fetch
  };
  t.after(() => {
    config.demoMode = original.demoMode;
    config.removeBgApiKey = original.removeBgApiKey;
    config.removeBgSize = original.removeBgSize;
    config.geminiApiKey = original.geminiApiKey;
    config.pixabayApiKey = original.pixabayApiKey;
    config.cloudflareAccountId = original.cloudflareAccountId;
    config.cloudflareApiToken = original.cloudflareApiToken;
    globalThis.fetch = original.fetch;
  });
  Object.assign(config, {
    demoMode: false,
    removeBgApiKey: "remove-bg-key",
    removeBgSize: "auto",
    geminiApiKey: "",
    pixabayApiKey: "",
    cloudflareAccountId: "",
    cloudflareApiToken: ""
  });
  const sourceBytes = await sharp({
    create: { width: 220, height: 280, channels: 3, background: "#ffffff" }
  }).png().toBuffer();
  const cutoutBytes = await sharp({
    create: { width: 220, height: 280, channels: 4, background: { r: 190, g: 70, b: 30, alpha: 0.7 } }
  }).png().toBuffer();
  const source = await storeMedia({ bytes: sourceBytes, mimeType: "image/png", filename: "source-product.png", kind: "PRIMARY_PRODUCT" });
  let removalCalls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.remove.bg/v1.0/removebg");
    assert.equal(options.body.get("type"), "product");
    removalCalls += 1;
    return new Response(cutoutBytes, { status: 200, headers: { "content-type": "image/png", "x-credits-charged": "1" } });
  };

  const job = await createDesignJob({ product: "Orange Sneaker", brand: "Example" }, { productAssetIds: [source.id] });
  assert.equal(removalCalls, 1);
  assert.equal(job.assets[0].backgroundRemoved, true);
  assert.notEqual(job.assets[0].assetId, source.id);
  const storedCutout = await readMedia(job.assets[0].assetId);
  assert.equal(storedCutout.record.kind, "PRODUCT_CUTOUT");
  assert.equal((await sharp(storedCutout.bytes).metadata()).hasAlpha, true);
  assert.ok(job.activityLogs.some(entry => entry.stage === "BACKGROUND_REMOVAL" && entry.status === "SUCCESS"));
});

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

test("routes dashboard previews only to the dashboard handoff", async t => {
  const job = await makeJob();
  job.sourceChannel = "dashboard";
  job.targetChannels = ["instagram"];
  const originalDashboardUrl = config.dashboardHandoffUrl;
  const originalWhatsAppUrl = config.whatsappHandoffUrl;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    config.dashboardHandoffUrl = originalDashboardUrl;
    config.whatsappHandoffUrl = originalWhatsAppUrl;
    globalThis.fetch = originalFetch;
  });
  config.dashboardHandoffUrl = "https://dashboard.internal.test/integrations/agentic/previews";
  config.whatsappHandoffUrl = "https://whatsapp.internal.test/whatsapp/integrations/agentic/previews";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, config.dashboardHandoffUrl);
    const metadata = JSON.parse(options.body.get("metadata"));
    assert.equal(metadata.sourceChannel, "dashboard");
    assert.deepEqual(metadata.targetChannels, ["instagram"]);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const result = await deliverPreviewPack(job);
  assert.equal(result.status, "DELIVERED");
  await assert.rejects(
    () => processWhatsAppFeedback(job.id, { action: "APPROVE_ALL", messageId: `wrong-owner-${job.id}` }),
    /belongs to the dashboard integration/i
  );
});

test("an explicit empty target channel list exports without social publishing", async t => {
  const job = await makeJob();
  job.sourceChannel = "dashboard";
  job.targetChannels = [];
  const original = {
    instagramUrl: config.instagramPublishUrl,
    instagramKey: config.instagramPublishApiKey,
    facebookCloud: config.facebookCloudinaryCloudName,
    facebookKey: config.facebookCloudinaryApiKey,
    facebookSecret: config.facebookCloudinaryApiSecret,
    facebookUrl: config.facebookPublishUrl,
    facebookPublishSecret: config.facebookPublishSecret,
    genericUrl: config.publishingHandoffUrl
  };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    config.instagramPublishUrl = original.instagramUrl;
    config.instagramPublishApiKey = original.instagramKey;
    config.facebookCloudinaryCloudName = original.facebookCloud;
    config.facebookCloudinaryApiKey = original.facebookKey;
    config.facebookCloudinaryApiSecret = original.facebookSecret;
    config.facebookPublishUrl = original.facebookUrl;
    config.facebookPublishSecret = original.facebookPublishSecret;
    config.publishingHandoffUrl = original.genericUrl;
    globalThis.fetch = originalFetch;
  });
  config.instagramPublishUrl = "https://instagram.test/publish";
  config.instagramPublishApiKey = "instagram-key";
  config.facebookCloudinaryCloudName = "facebook-cloud";
  config.facebookCloudinaryApiKey = "facebook-key";
  config.facebookCloudinaryApiSecret = "facebook-secret";
  config.facebookPublishUrl = "https://facebook.test/publish";
  config.facebookPublishSecret = "facebook-publish-secret";
  config.publishingHandoffUrl = "";
  globalThis.fetch = async () => { throw new Error("No publisher should be called."); };
  const approved = await approveDesigns(job.id, { designIds: ["design_1"], idempotencyKey: `no-publish-${job.id}` });
  const publishing = approved.handoffs.find(item => item.type === "PUBLISHING");
  assert.equal(publishing.status, "NOT_CONFIGURED");
  assert.deepEqual(publishing.deliveries, []);
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
      cost: 800,
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

test("sends only the approved portrait image to the Instagram publisher", async t => {
  const job = await makeJob();
  const original = {
    instagramUrl: config.instagramPublishUrl,
    instagramKey: config.instagramPublishApiKey,
    facebookCloudName: config.facebookCloudinaryCloudName,
    facebookApiKey: config.facebookCloudinaryApiKey,
    facebookApiSecret: config.facebookCloudinaryApiSecret,
    facebookUrl: config.facebookPublishUrl,
    facebookSecret: config.facebookPublishSecret,
    genericUrl: config.publishingHandoffUrl,
    fetch: globalThis.fetch
  };
  t.after(() => {
    config.instagramPublishUrl = original.instagramUrl;
    config.instagramPublishApiKey = original.instagramKey;
    config.facebookCloudinaryCloudName = original.facebookCloudName;
    config.facebookCloudinaryApiKey = original.facebookApiKey;
    config.facebookCloudinaryApiSecret = original.facebookApiSecret;
    config.facebookPublishUrl = original.facebookUrl;
    config.facebookPublishSecret = original.facebookSecret;
    config.publishingHandoffUrl = original.genericUrl;
    globalThis.fetch = original.fetch;
  });
  config.instagramPublishUrl = "https://jiit-hackathon.example/api/post";
  config.instagramPublishApiKey = "instagram-shared-key";
  config.facebookCloudinaryCloudName = "";
  config.facebookCloudinaryApiKey = "";
  config.facebookCloudinaryApiSecret = "";
  config.facebookPublishUrl = "";
  config.facebookPublishSecret = "";
  config.publishingHandoffUrl = "";
  let call = 0;
  globalThis.fetch = async (url, options) => {
    call += 1;
    assert.equal(url, config.instagramPublishUrl);
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-API-Key"], "instagram-shared-key");
    assert.equal(options.headers["idempotency-key"], `instagram:${job.id}:${job.currentRevisionId}`);
    assert.ok(options.body instanceof FormData);
    assert.deepEqual([...options.body.keys()], ["file"]);
    const file = options.body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "image/png");
    return new Response(JSON.stringify({
      ok: true,
      type: "image",
      instagram_post_id: "ig-post-789",
      caption: "A new cotton kurti. #newarrival"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const approved = await approveDesigns(job.id, { designIds: ["design_1"], idempotencyKey: `instagram-approve-${job.id}` });
  assert.equal(call, 1);
  const delivery = approved.handoffs.find(item => item.type === "PUBLISHING");
  assert.equal(delivery.status, "DELIVERED");
  assert.equal(delivery.deliveries[0].channel, "instagram");
  assert.equal(delivery.deliveries[0].instagramPostId, "ig-post-789");
});

test("automatically publishes Shopify with a placeholder cost when no cost or Shopify target was supplied", async t => {
  const job = await makeJob();
  job.targetChannels = [];
  job.commerce = { sku: "KURTI-001", vendor: "Kavya Boutique", productType: "Apparel" };
  const original = {
    cloudName: config.shopifyCloudinaryCloudName,
    apiKey: config.shopifyCloudinaryApiKey,
    apiSecret: config.shopifyCloudinaryApiSecret,
    publishUrl: config.shopifyPublishUrl,
    publishSecret: config.shopifyPublishSecret,
    genericUrl: config.publishingHandoffUrl,
    fetch: globalThis.fetch
  };
  t.after(() => {
    config.shopifyCloudinaryCloudName = original.cloudName;
    config.shopifyCloudinaryApiKey = original.apiKey;
    config.shopifyCloudinaryApiSecret = original.apiSecret;
    config.shopifyPublishUrl = original.publishUrl;
    config.shopifyPublishSecret = original.publishSecret;
    config.publishingHandoffUrl = original.genericUrl;
    globalThis.fetch = original.fetch;
  });
  config.shopifyCloudinaryCloudName = "shopify-cloud";
  config.shopifyCloudinaryApiKey = "shopify-key";
  config.shopifyCloudinaryApiSecret = "shopify-secret";
  config.shopifyPublishUrl = "https://storebot-shopify.example/process";
  config.shopifyPublishSecret = "webhook-secret";
  config.publishingHandoffUrl = "";
  let call = 0;
  globalThis.fetch = async (url, options) => {
    call += 1;
    if (call === 1) {
      assert.equal(url, "https://api.cloudinary.com/v1_1/shopify-cloud/image/upload");
      assert.ok(options.body.get("file") instanceof Blob);
      assert.match(options.body.get("public_id"), /^storebot\/shopify\//);
      return new Response(JSON.stringify({
        public_id: options.body.get("public_id"),
        secure_url: "https://res.cloudinary.com/shopify-cloud/image/upload/product.png"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(url, config.shopifyPublishUrl);
    assert.equal(options.headers.authorization, "Bearer webhook-secret");
    assert.equal(options.headers["idempotency-key"], `shopify:${job.id}:${job.currentRevisionId}`);
    const body = JSON.parse(options.body);
    assert.equal(body.approved, true);
    assert.ok(body.dashboard.product.cost >= 100 && body.dashboard.product.cost <= 999);
    assert.equal(body.dashboard.product.sku, "KURTI-001");
    assert.equal(body.dashboard.product.price, undefined);
    assert.equal(body.selling_price, undefined);
    return new Response(JSON.stringify({
      message: "Product created successfully.",
      product_id: "gid://shopify/Product/123",
      title: "Cotton Kurti",
      status: "DRAFT",
      cost: String(body.dashboard.product.cost),
      selling_price: "1120.00"
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const approved = await approveDesigns(job.id, { designIds: ["design_1"], idempotencyKey: `shopify-approve-${job.id}` });
  assert.equal(call, 2);
  const delivery = approved.handoffs.find(item => item.type === "PUBLISHING");
  assert.equal(delivery.status, "DELIVERED");
  assert.equal(delivery.deliveries[0].channel, "shopify");
  assert.equal(delivery.deliveries[0].shopifyProductId, "gid://shopify/Product/123");
  assert.equal(delivery.deliveries[0].sellingPrice, "1120.00");
});
