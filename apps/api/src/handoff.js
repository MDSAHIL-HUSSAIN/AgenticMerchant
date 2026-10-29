import { config } from "./config.js";
import { readMedia } from "./media-store.js";
import { createHash } from "node:crypto";

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

function cloudinarySignature(params) {
  const serialized = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha1").update(`${serialized}${config.facebookCloudinaryApiSecret}`).digest("hex");
}

async function uploadFacebookImage(job, asset) {
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
  const response = await fetch(uploadUrl, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.secure_url || !body.public_id) {
    throw new Error(`Facebook Cloudinary upload failed (${response.status}): ${String(body.error?.message || "unknown response").slice(0, 240)}`);
  }
  return { publicId: body.public_id, secureUrl: body.secure_url, bytes: record.byteLength };
}

async function triggerExistingFacebookPublisher(job) {
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
    throw new Error(`Facebook publisher failed (${response.status}): ${String(payload.error || payload.message || text).slice(0, 300)}`);
  }
  return payload;
}

export async function deliverFacebookAsset(job) {
  if (!facebookConfigured()) return { status: "NOT_CONFIGURED", deliveredAt: null, channel: "facebook" };
  const asset = (job.finalAssets || []).find(item => item.platform === "facebook_feed");
  if (!asset) throw new Error("The approved job has no facebook_feed export.");
  const cloudinary = await uploadFacebookImage(job, asset);
  // The teammate's current publisher always selects the newest untagged image.
  // Upload and trigger are deliberately sequential, and only one Facebook
  // creative exists in the prototype.
  const publisher = await triggerExistingFacebookPublisher(job);
  return {
    status: "DELIVERED",
    channel: "facebook",
    deliveredAt: new Date().toISOString(),
    cloudinaryPublicId: cloudinary.publicId,
    facebookPostId: publisher.result?.facebook_post_id || publisher.facebook_post_id || null,
    facebookPhotoId: publisher.result?.facebook_photo_id || publisher.facebook_photo_id || null,
    publisher
  };
}

async function postMultipart(url, metadata, assets, idempotencyKey) {
  if (!url) return { status: "NOT_CONFIGURED", deliveredAt: null };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (let index = 0; index < assets.length; index += 1) {
    const { record, bytes } = await readMedia(assets[index].assetId);
    const partName = assets[index].filePart || `file_${index + 1}`;
    form.append(partName, new Blob([bytes], { type: record.mimeType }), record.filename);
  }
  const headers = {};
  if (config.internalServiceToken) headers.authorization = `Bearer ${config.internalServiceToken}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(60_000) });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Handoff returned ${response.status}: ${responseText.slice(0, 300)}`);
  return { status: "DELIVERED", deliveredAt: new Date().toISOString(), response: responseText.slice(0, 500) };
}

export async function deliverPreviewPack(job) {
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
    return postMultipart(config.whatsappHandoffUrl, metadata, assets, `preview:${job.id}:${job.currentRevisionId}`);
  }
  const metadata = {
    event: "design.preview_ready",
    merchantId: job.merchantId,
    conversationId: job.conversationId,
    productId: job.productId,
    designJobId: job.id,
    revisionId: job.currentRevisionId,
    revisionNumber: job.revisionNumber,
    designs: job.designs.map((design, index) => ({
      designId: design.id,
      concept: design.kind,
      filePart: `preview_${index + 1}`
    })),
    actions: ["APPROVE_ALL", "APPROVE_SELECTED", "EDIT_SELECTED", "REJECT_SELECTED", "REJECT_ALL", "EDIT_MANUALLY"]
  };
  return postMultipart(config.whatsappHandoffUrl, metadata, assets, `preview:${job.id}:${job.currentRevisionId}`);
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
  if (job.type !== "VIDEO_POST" && facebookConfigured()) {
    attempts.push(
      deliverFacebookAsset(job).catch(error => ({
        status: "FAILED",
        channel: "facebook",
        deliveredAt: null,
        error: error.message
      }))
    );
  }
  if (config.publishingHandoffUrl) {
    attempts.push(
      postMultipart(config.publishingHandoffUrl, metadata, assets, `publish:${job.id}:${job.currentRevisionId}`)
        .then(result => ({ channel: "generic", ...result }))
        .catch(error => ({ status: "FAILED", channel: "generic", deliveredAt: null, error: error.message }))
    );
  }
  if (!attempts.length) return { status: "NOT_CONFIGURED", deliveredAt: null, deliveries: [] };
  const deliveries = await Promise.all(attempts);
  const deliveredCount = deliveries.filter(item => item.status === "DELIVERED").length;
  return {
    status: deliveredCount === deliveries.length ? "DELIVERED" : deliveredCount ? "PARTIAL" : "FAILED",
    deliveredAt: deliveredCount ? new Date().toISOString() : null,
    deliveries
  };
}
