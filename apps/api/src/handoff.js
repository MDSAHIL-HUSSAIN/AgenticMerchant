import { config } from "./config.js";
import { readMedia } from "./media-store.js";
import { createHash } from "node:crypto";
import { appendJobLog } from "./job-store.js";

function activity(job, channel, stage, status, message, details = null) {
  return appendJobLog(job, { channel, stage, status, message, details });
}

const cleanSegment = value => String(value || "item")
  .normalize("NFKD")
  .replace(/[^a-z0-9]+/gi, "_")
  .replace(/^_+|_+$/g, "")
  .slice(0, 70) || "item";

function facebookConfigured() {
  return Boolean(
    config.facebookCloudinaryCloudName &&
    config.facebookCloudinaryApiKey &&
    config.facebookCloudinaryApiSecret &&
    config.facebookPublishUrl &&
    config.facebookPublishSecret
  );
}

function instagramConfigured() {
  return Boolean(config.instagramPublishUrl && config.instagramPublishApiKey);
}

function shopifyConfigured() {
  return Boolean(
    config.shopifyCloudinaryCloudName &&
    config.shopifyCloudinaryApiKey &&
    config.shopifyCloudinaryApiSecret &&
    config.shopifyPublishUrl &&
    config.shopifyPublishSecret
  );
}

function previewDestination(job) {
  if ((job.sourceChannel || "whatsapp") === "dashboard") {
    return { url: config.dashboardHandoffUrl, channel: "dashboard", label: "dashboard" };
  }
  return { url: config.whatsappHandoffUrl, channel: "whatsapp", label: "WhatsApp" };
}

function requestedChannels(job) {
  if (!Array.isArray(job.targetChannels)) return new Set(["instagram", "facebook", "shopify"]);
  return new Set(job.targetChannels.map(item => String(item).toLowerCase()));
}

function placeholderShopifyCost(job) {
  const source = String(job.productId || job.id || "shopify-product");
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return 100 + (Math.abs(hash) % 900);
}

function cloudinarySignature(params, apiSecret = config.facebookCloudinaryApiSecret) {
  const serialized = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${serialized}${apiSecret}`).digest("hex");
}

async function uploadFacebookImage(job, asset) {
  activity(job, "facebook", "MEDIA_READ", "RUNNING", "Reading the Facebook image export from local storage.", { assetId: asset.assetId, platform: asset.platform });
  const { record, bytes } = await readMedia(asset.assetId);
  const timestamp = Math.floor(Date.now() / 1000);
  const productLabel = cleanSegment([job.brief?.brand, job.brief?.product].filter(Boolean).join(" "));
  const publicId = [
    "storebot", "facebook", cleanSegment(job.merchantId || "merchant"),
    cleanSegment(job.productId || job.id), cleanSegment(job.currentRevisionId), productLabel
  ].join("/");
  const signed = { public_id: publicId, timestamp };
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: record.mimeType }), record.filename);
  form.append("api_key", config.facebookCloudinaryApiKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("signature", cloudinarySignature(signed));
  const uploadUrl = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.facebookCloudinaryCloudName)}/image/upload`;
  activity(job, "facebook", "MEDIA_UPLOAD", "RUNNING", "Uploading the approved image to Facebook's media staging service.", { filename: record.filename, mimeType: record.mimeType, bytes: record.byteLength });
  const response = await fetch(uploadUrl, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.secure_url || !body.public_id) {
    activity(job, "facebook", "MEDIA_UPLOAD", "FAILED", "Facebook media staging upload failed.", { httpStatus: response.status, reason: body.error?.message || "unknown response" });
    throw new Error(`Facebook Cloudinary upload failed (${response.status}): ${String(body.error?.message || "unknown response").slice(0, 240)}`);
  }
  activity(job, "facebook", "MEDIA_UPLOAD", "SUCCESS", "Facebook image upload completed successfully.", { publicId: body.public_id, bytes: record.byteLength });
  return { publicId: body.public_id, secureUrl: body.secure_url, bytes: record.byteLength };
}

async function triggerExistingFacebookPublisher(job) {
  activity(job, "facebook", "POST_CREATE", "RUNNING", "Requesting creation of the Facebook Page post.");
  const response = await fetch(config.facebookPublishUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.facebookPublishSecret}`,
      "idempotency-key": `facebook:${job.id}:${job.currentRevisionId}`
    },
    signal: AbortSignal.timeout(75_000)
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok || payload.success === false) {
    activity(job, "facebook", "POST_CREATE", "FAILED", "Facebook rejected the Page publishing request.", { httpStatus: response.status, reason: payload.error || payload.message || text });
    throw new Error(`Facebook publisher failed (${response.status}): ${String(payload.error || payload.message || text).slice(0, 300)}`);
  }
  activity(job, "facebook", "POST_CREATE", "SUCCESS", "Facebook accepted and published the Page post.", { httpStatus: response.status, facebookPostId: payload.result?.facebook_post_id || payload.facebook_post_id || null });
  return payload;
}

export async function deliverFacebookAsset(job) {
  if (!facebookConfigured()) {
    activity(job, "facebook", "CONFIGURATION", "SKIPPED", "Facebook publishing was skipped because its connection is not configured.");
    return { status: "NOT_CONFIGURED", deliveredAt: null, channel: "facebook" };
  }
  activity(job, "facebook", "PUBLISH", "STARTED", "Starting Facebook publishing for the approved image.");
  const asset = (job.finalAssets || []).find(item => item.platform === "facebook_feed");
  if (!asset) {
    activity(job, "facebook", "ASSET_SELECTION", "FAILED", "No Facebook feed export was found in the approved assets.");
    throw new Error("The approved job has no facebook_feed export.");
  }
  const cloudinary = await uploadFacebookImage(job, asset);
  // The teammate's current publisher always selects the newest untagged image.
  // Upload and trigger are deliberately sequential, and only one Facebook
  // creative exists in the prototype.
  const publisher = await triggerExistingFacebookPublisher(job);
  const result = {
    status: "DELIVERED",
    channel: "facebook",
    deliveredAt: new Date().toISOString(),
    cloudinaryPublicId: cloudinary.publicId,
    facebookPostId: publisher.result?.facebook_post_id || publisher.facebook_post_id || null,
    facebookPhotoId: publisher.result?.facebook_photo_id || publisher.facebook_photo_id || null,
    publisher
  };
  activity(job, "facebook", "PUBLISH", "SUCCESS", "Facebook publishing completed.", { facebookPostId: result.facebookPostId, facebookPhotoId: result.facebookPhotoId });
  return result;
}

export async function deliverInstagramImage(job) {
  if (!instagramConfigured()) {
    activity(job, "instagram", "CONFIGURATION", "SKIPPED", "Instagram publishing was skipped because its connection is not configured.");
    return { status: "NOT_CONFIGURED", deliveredAt: null, channel: "instagram" };
  }
  if (job.type === "VIDEO_POST") {
    activity(job, "instagram", "ASSET_SELECTION", "SKIPPED", "The connected Instagram publisher currently accepts image posts; this video job was not sent as an image.");
    return { status: "NOT_CONFIGURED", deliveredAt: null, channel: "instagram" };
  }
  activity(job, "instagram", "PUBLISH", "STARTED", "Starting Instagram publishing for the approved portrait image.");
  const asset = (job.finalAssets || []).find(item => item.platform === "instagram_portrait");
  if (!asset) {
    activity(job, "instagram", "ASSET_SELECTION", "FAILED", "No Instagram portrait export was found in the approved assets.");
    throw new Error("The approved job has no instagram_portrait export.");
  }
  const { record, bytes } = await readMedia(asset.assetId);
  activity(job, "instagram", "MEDIA_UPLOAD", "RUNNING", "Uploading the Instagram portrait to the connected publisher.", { assetId: asset.assetId, filename: record.filename, mimeType: record.mimeType, bytes: record.byteLength });
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: record.mimeType }), record.filename);
  const response = await fetch(config.instagramPublishUrl, {
    method: "POST",
    headers: {
      "X-API-Key": config.instagramPublishApiKey,
      "idempotency-key": `instagram:${job.id}:${job.currentRevisionId}`
    },
    body: form,
    // The teammate service waits for Instagram's media container to finish.
    signal: AbortSignal.timeout(420_000)
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok || payload.ok === false || !payload.instagram_post_id) {
    activity(job, "instagram", "PUBLISH", "FAILED", "Instagram publishing failed.", { httpStatus: response.status, reason: payload.error || text || "unknown response" });
    throw new Error(`Instagram publisher failed (${response.status}): ${String(payload.error || text || "unknown response").slice(0, 300)}`);
  }
  const result = {
    status: "DELIVERED",
    channel: "instagram",
    deliveredAt: new Date().toISOString(),
    instagramPostId: payload.instagram_post_id,
    postType: payload.type || "image",
    caption: payload.caption || null,
    publisher: payload
  };
  activity(job, "instagram", "PUBLISH", "SUCCESS", "Instagram published the image successfully.", { instagramPostId: result.instagramPostId, postType: result.postType });
  return result;
}

async function uploadShopifyImage(job, asset) {
  activity(job, "shopify", "MEDIA_READ", "RUNNING", "Reading the approved Shopify image export from local storage.", { assetId: asset.assetId, platform: asset.platform });
  const { record, bytes } = await readMedia(asset.assetId);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = [
    "storebot", "shopify", cleanSegment(job.merchantId || "merchant"),
    cleanSegment(job.productId || job.id), cleanSegment(job.currentRevisionId)
  ].join("/");
  const signed = { public_id: publicId, timestamp };
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: record.mimeType }), record.filename);
  form.append("api_key", config.shopifyCloudinaryApiKey);
  form.append("timestamp", String(timestamp));
  form.append("public_id", publicId);
  form.append("signature", cloudinarySignature(signed, config.shopifyCloudinaryApiSecret));
  const uploadUrl = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.shopifyCloudinaryCloudName)}/image/upload`;
  activity(job, "shopify", "MEDIA_UPLOAD", "RUNNING", "Uploading the approved Shopify image to StoreBot's media account.", { filename: record.filename, mimeType: record.mimeType, bytes: record.byteLength });
  const response = await fetch(uploadUrl, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.secure_url || !body.public_id) {
    activity(job, "shopify", "MEDIA_UPLOAD", "FAILED", "Shopify media staging upload failed.", { httpStatus: response.status, reason: body.error?.message || "unknown response" });
    throw new Error(`Shopify Cloudinary upload failed (${response.status}): ${String(body.error?.message || "unknown response").slice(0, 240)}`);
  }
  activity(job, "shopify", "MEDIA_UPLOAD", "SUCCESS", "Shopify image upload completed successfully.", { publicId: body.public_id, bytes: record.byteLength });
  return { publicId: body.public_id, secureUrl: body.secure_url, bytes: record.byteLength };
}

export async function deliverShopifyImage(job) {
  if (!shopifyConfigured()) {
    activity(job, "shopify", "CONFIGURATION", "SKIPPED", "Shopify publishing was skipped because its connection is not configured.");
    return { status: "NOT_CONFIGURED", deliveredAt: null, channel: "shopify" };
  }
  const suppliedCost = Number(job.commerce?.cost);
  const cost = suppliedCost > 0 ? suppliedCost : placeholderShopifyCost(job);
  if (!(suppliedCost > 0)) {
    activity(job, "shopify", "PRODUCT_DATA", "INFO", "No product cost was supplied; using a stable placeholder cost for the Shopify draft.", { placeholderCost: cost });
  }
  const asset = (job.finalAssets || []).find(item => item.platform === "shopify");
  if (!asset) {
    activity(job, "shopify", "ASSET_SELECTION", "FAILED", "No Shopify export was found in the approved assets.");
    throw new Error("The approved job has no shopify export.");
  }
  activity(job, "shopify", "PUBLISH", "STARTED", "Starting Shopify draft-product creation for the approved image.");
  const cloudinary = await uploadShopifyImage(job, asset);
  const product = {
    public_id: cloudinary.publicId,
    cost,
    sku: job.commerce?.sku || undefined,
    vendor: job.commerce?.vendor || job.brief?.brand || undefined,
    product_type: job.commerce?.productType || job.brief?.category || undefined
  };
  const response = await fetch(config.shopifyPublishUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.shopifyPublishSecret}`,
      "content-type": "application/json",
      "idempotency-key": `shopify:${job.id}:${job.currentRevisionId}`
    },
    body: JSON.stringify({ approved: true, public_id: cloudinary.publicId, dashboard: { product } }),
    signal: AbortSignal.timeout(180_000)
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok || !payload.product_id) {
    activity(job, "shopify", "PRODUCT_CREATE", "FAILED", "StoreBot failed to create the Shopify draft product.", { httpStatus: response.status, reason: payload.error || text || "unknown response" });
    throw new Error(`Shopify publisher failed (${response.status}): ${String(payload.error || text || "unknown response").slice(0, 300)}`);
  }
  const result = {
    status: "DELIVERED",
    channel: "shopify",
    deliveredAt: new Date().toISOString(),
    cloudinaryPublicId: cloudinary.publicId,
    shopifyProductId: payload.product_id,
    productStatus: payload.status || "DRAFT",
    title: payload.title || null,
    sellingPrice: payload.selling_price || null,
    publisher: payload
  };
  activity(job, "shopify", "PUBLISH", "SUCCESS", "Shopify draft product creation completed.", { shopifyProductId: result.shopifyProductId, productStatus: result.productStatus });
  return result;
}

async function postMultipart(url, metadata, assets, idempotencyKey, logContext = {}) {
  const { job = null, channel = "handoff", purpose = "media handoff" } = logContext;
  if (!url) {
    if (job) activity(job, channel, "CONFIGURATION", "SKIPPED", `${purpose} was skipped because the destination is not configured.`);
    return { status: "NOT_CONFIGURED", deliveredAt: null };
  }
  if (job) activity(job, channel, "HANDOFF", "STARTED", `Starting ${purpose}.`, { assetCount: assets.length, event: metadata.event });
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (let index = 0; index < assets.length; index += 1) {
    const { record, bytes } = await readMedia(assets[index].assetId);
    const partName = assets[index].filePart || `file_${index + 1}`;
    form.append(partName, new Blob([bytes], { type: record.mimeType }), record.filename);
    if (job) activity(job, channel, "MEDIA_ATTACHED", "SUCCESS", `Attached media ${index + 1} of ${assets.length} to the ${purpose}.`, { assetId: assets[index].assetId, filename: record.filename, mimeType: record.mimeType, bytes: record.byteLength });
  }
  const headers = {};
  if (config.internalServiceToken) headers.authorization = `Bearer ${config.internalServiceToken}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(60_000) });
  const responseText = await response.text();
  if (!response.ok) {
    if (job) activity(job, channel, "HANDOFF", "FAILED", `${purpose} failed.`, { httpStatus: response.status, response: responseText.slice(0, 300) });
    throw new Error(`Handoff returned ${response.status}: ${responseText.slice(0, 300)}`);
  }
  if (job) activity(job, channel, "HANDOFF", "SUCCESS", `${purpose} completed successfully.`, { httpStatus: response.status, response: responseText.slice(0, 300) });
  return { status: "DELIVERED", deliveredAt: new Date().toISOString(), response: responseText.slice(0, 500) };
}

export async function deliverPreviewPack(job) {
  const destination = previewDestination(job);
  const assets = (job.previewAssets || []).map((asset, index) => ({ ...asset, filePart: `preview_${index + 1}` }));
  if (job.type === "VIDEO_POST") {
    const metadata = {
      event: "video.preview_ready",
      merchantId: job.merchantId,
      conversationId: job.conversationId,
      productId: job.productId,
      designJobId: job.id,
      jobType: job.type,
      revisionId: job.currentRevisionId,
      revisionNumber: job.revisionNumber,
      durationSeconds: job.videoSpec?.durationSeconds,
      aspectRatio: job.videoSpec?.aspectRatio,
      assets: assets.map((asset, index) => ({ assetId: asset.assetId, mimeType: asset.mimeType, kind: asset.kind, filePart: `preview_${index + 1}` })),
      actions: ["APPROVE_ALL", "EDIT_SELECTED", "REJECT_ALL"]
    };
    return postMultipart(destination.url, metadata, assets, `preview:${job.id}:${job.currentRevisionId}`, { job, channel: destination.channel, purpose: `${destination.label} video preview delivery` });
  }
  const metadata = {
    event: "design.preview_ready",
    merchantId: job.merchantId,
    conversationId: job.conversationId,
    productId: job.productId,
    designJobId: job.id,
    revisionId: job.currentRevisionId,
    revisionNumber: job.revisionNumber,
    sourceChannel: job.sourceChannel || "whatsapp",
    targetChannels: Array.isArray(job.targetChannels) ? job.targetChannels : ["instagram", "facebook", "shopify"],
    designs: job.designs.map((design, index) => ({
      designId: design.id,
      concept: design.kind,
      filePart: `preview_${index + 1}`
    })),
    actions: ["APPROVE_ALL", "APPROVE_SELECTED", "EDIT_SELECTED", "REJECT_SELECTED", "REJECT_ALL", "EDIT_MANUALLY"]
  };
  return postMultipart(destination.url, metadata, assets, `preview:${job.id}:${job.currentRevisionId}`, { job, channel: destination.channel, purpose: `${destination.label} image preview delivery` });
}

export async function deliverPublishingAssets(job) {
  const assets = (job.finalAssets || []).map((asset, index) => ({ ...asset, filePart: `asset_${index + 1}` }));
  const metadata = {
    event: job.type === "VIDEO_POST" ? "video.final_assets_ready" : "design.final_assets_ready",
    merchantId: job.merchantId,
    conversationId: job.conversationId,
    productId: job.productId,
    designJobId: job.id,
    jobType: job.type || "IMAGE_POST",
    revisionId: job.currentRevisionId,
    approvedDesignIds: job.approvedDesignIds,
    assets: assets.map((asset, index) => ({
      assetId: asset.assetId,
      designId: asset.designId || null,
      platform: asset.platform,
      width: asset.width,
      height: asset.height,
      mimeType: asset.mimeType,
      filePart: `asset_${index + 1}`
    }))
  };
  const attempts = [];
  const targets = requestedChannels(job);
  activity(job, "publishing", "PUBLISHING", "STARTED", "Starting delivery to all configured social publishing destinations.", { jobType: job.type, assetCount: assets.length });
  if (targets.has("facebook") && job.type !== "VIDEO_POST" && facebookConfigured()) {
    attempts.push(
      deliverFacebookAsset(job).catch(error => {
        activity(job, "facebook", "PUBLISH", "FAILED", "Facebook publishing stopped with an error.", { error: error.message });
        return { status: "FAILED", channel: "facebook", deliveredAt: null, error: error.message };
      })
    );
  } else {
    activity(job, "facebook", "PUBLISH", "SKIPPED", !targets.has("facebook")
      ? "Facebook publishing was not requested for this job."
      : job.type === "VIDEO_POST"
      ? "The current Facebook publisher is image-only, so the video export was not sent through that connector."
      : "Facebook publishing was skipped because its connection is not configured.");
  }
  if (targets.has("instagram") && job.type !== "VIDEO_POST" && instagramConfigured()) {
    attempts.push(
      deliverInstagramImage(job).catch(error => {
        activity(job, "instagram", "PUBLISH", "FAILED", "Instagram publishing stopped with an error.", { error: error.message });
        return { status: "FAILED", channel: "instagram", deliveredAt: null, error: error.message };
      })
    );
  } else {
    activity(job, "instagram", "PUBLISH", "SKIPPED", !targets.has("instagram")
      ? "Instagram publishing was not requested for this job."
      : job.type === "VIDEO_POST"
      ? "The current Instagram connector is image-only, so the video export was not sent through that connector."
      : "Instagram publishing was skipped because its connection is not configured.");
  }
  if (job.type !== "VIDEO_POST" && shopifyConfigured()) {
    attempts.push(
      deliverShopifyImage(job).catch(error => {
        activity(job, "shopify", "PUBLISH", "FAILED", "Shopify publishing stopped with an error.", { error: error.message });
        return { status: "FAILED", channel: "shopify", deliveredAt: null, error: error.message };
      })
    );
  } else {
    activity(job, "shopify", "PUBLISH", "SKIPPED", job.type === "VIDEO_POST"
      ? "The Shopify connector accepts image products only, so video was not sent."
      : "Shopify publishing was skipped because its connection is not configured.");
  }
  if (targets.size && config.publishingHandoffUrl) {
    attempts.push(
      postMultipart(config.publishingHandoffUrl, metadata, assets, `publish:${job.id}:${job.currentRevisionId}`, { job, channel: "publisher", purpose: "generic publishing delivery" })
        .then(result => ({ channel: "generic", ...result }))
        .catch(error => ({ status: "FAILED", channel: "generic", deliveredAt: null, error: error.message }))
    );
  }
  activity(job, "whatsapp", "FINAL_DELIVERY", "SKIPPED", "WhatsApp receives review previews only; approved final assets are not sent again.");
  if (!attempts.length) {
    activity(job, "publishing", "PUBLISHING", "SKIPPED", "No social publishing destination is configured.");
    return { status: "NOT_CONFIGURED", deliveredAt: null, deliveries: [] };
  }
  const deliveries = await Promise.all(attempts);
  const deliveredCount = deliveries.filter(item => item.status === "DELIVERED").length;
  const result = {
    status: deliveredCount === deliveries.length ? "DELIVERED" : deliveredCount ? "PARTIAL" : "FAILED",
    deliveredAt: deliveredCount ? new Date().toISOString() : null,
    deliveries
  };
  activity(job, "publishing", "PUBLISHING", result.status === "DELIVERED" ? "SUCCESS" : result.status === "PARTIAL" ? "WARNING" : "FAILED", `Publishing finished with status ${result.status}.`, { deliveredCount, attemptedCount: deliveries.length, deliveries: deliveries.map(item => ({ channel: item.channel, status: item.status, error: item.error || null })) });
  return result;
}
