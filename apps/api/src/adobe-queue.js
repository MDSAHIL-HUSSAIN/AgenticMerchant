import { getJob, saveJob } from "./job-store.js";
import { storeMedia } from "./media-store.js";
import { addAdobeRevision } from "./revisions.js";
import sharp from "sharp";

const adobeJobs = new Map();

function publicAdobeJob(item) {
  return structuredClone(item);
}

export function createAdobeEditJob(designJobId, { designId, requestedBy = "merchant" } = {}) {
  const job = getJob(designJobId);
  if (["APPROVED", "READY_FOR_PUBLISHING"].includes(job.status)) throw new Error("The approved revision is locked.");
  const design = designId ? job.designs.find(item => item.id === designId) : job.designs[0];
  if (!design) throw new Error("Design not found.");
  const productAsset = job.assets[Number(design.imageIndex) % Math.max(1, job.assets.length)] || null;
  const backgroundAsset = Number(design.backgroundIndex) >= 0 ? job.backgroundAssets?.[Number(design.backgroundIndex)] || null : null;
  const item = {
    id: `adobe_${crypto.randomUUID()}`,
    designJobId: job.id,
    revisionId: job.currentRevisionId,
    designId: design.id,
    requestedBy,
    status: "PENDING",
    design: structuredClone(design),
    brief: structuredClone(job.brief),
    productAsset: productAsset ? structuredClone(productAsset) : null,
    backgroundAsset: backgroundAsset ? structuredClone(backgroundAsset) : null,
    claimedAt: null,
    adobePageId: "",
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  adobeJobs.set(item.id, item);
  job.status = "AWAITING_ADOBE_EDIT";
  saveJob(job);
  return publicAdobeJob(item);
}

export function listPendingAdobeJobs() {
  return [...adobeJobs.values()].filter(item => item.status !== "COMPLETED").map(publicAdobeJob);
}

export function getAdobeJob(id) {
  const item = adobeJobs.get(String(id));
  if (!item) throw new Error("Adobe edit job not found.");
  return item;
}

export function claimAdobeJob(id) {
  const item = getAdobeJob(id);
  if (item.status === "COMPLETED") throw new Error("Adobe edit job is already complete.");
  item.status = "CLAIMED";
  item.claimedAt = new Date().toISOString();
  return publicAdobeJob(item);
}

export function attachAdobePage(id, adobePageId) {
  const item = getAdobeJob(id);
  item.adobePageId = String(adobePageId || "");
  item.status = "EDITING";
  return publicAdobeJob(item);
}

export async function completeAdobeJob(id, file, metadata = {}) {
  const item = getAdobeJob(id);
  if (!file?.buffer?.length) throw new Error("An Adobe rendition image is required.");
  const inspected = sharp(file.buffer, { limitInputPixels: 50_000_000 });
  const imageMetadata = await inspected.metadata();
  if (!imageMetadata.width || !imageMetadata.height || imageMetadata.width < 500 || imageMetadata.height < 500) {
    throw new Error("The Adobe rendition is too small or could not be decoded.");
  }
  const stats = await inspected.stats();
  if (Math.max(...stats.channels.slice(0, 3).map(channel => channel.stdev)) < 4) {
    throw new Error("The Adobe rendition appears visually empty.");
  }
  const stored = await storeMedia({
    bytes: file.buffer,
    mimeType: file.mimetype || "image/png",
    filename: file.originalname || `${item.designId}-adobe-edit.png`,
    kind: "ADOBE_MANUAL_PREVIEW",
    metadata: { designJobId: item.designJobId, designId: item.designId, adobeEditJobId: item.id }
  });
  const job = await addAdobeRevision(item.designJobId, {
    designId: item.designId,
    assetId: stored.id,
    adobePageId: metadata.adobePageId || item.adobePageId,
    feedback: metadata.feedback || "Manual Adobe edit"
  });
  item.status = "COMPLETED";
  item.completedAt = new Date().toISOString();
  item.resultAssetId = stored.id;
  return { adobeJob: publicAdobeJob(item), designJob: job };
}
