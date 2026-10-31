import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

function storageConfigured() {
  return Boolean(config.videoStorageEndpoint && config.videoStorageBucket && config.videoStorageAccessKeyId &&
    config.videoStorageSecretAccessKey && config.videoStoragePublicBaseUrl);
}

let client;
function getClient() {
  if (!storageConfigured()) throw new Error("Video object storage is not configured on Render.");
  if (!client) client = new S3Client({
    region: config.videoStorageRegion,
    endpoint: config.videoStorageEndpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.videoStorageAccessKeyId,
      secretAccessKey: config.videoStorageSecretAccessKey
    }
  });
  return client;
}

const safe = value => String(value || "unknown").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";

export async function createVideoUploadTicket(job) {
  const objectKey = `gemini-videos/${safe(job.merchantId)}/${safe(job.id)}/${safe(job.generationAttempt || 1)}.mp4`;
  const contentType = "video/mp4";
  const uploadUrl = await getSignedUrl(getClient(), new PutObjectCommand({
    Bucket: config.videoStorageBucket,
    Key: objectKey,
    ContentType: contentType
  }), { expiresIn: 15 * 60 });
  return {
    uploadUrl,
    objectKey,
    contentType,
    publicUrl: `${config.videoStoragePublicBaseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`,
    expiresInSeconds: 15 * 60
  };
}

export async function verifyVideoObject({ objectKey, expectedBytes }) {
  const result = await getClient().send(new HeadObjectCommand({ Bucket: config.videoStorageBucket, Key: objectKey }));
  const byteLength = Number(result.ContentLength || 0);
  if (!byteLength) throw new Error("The uploaded MP4 is empty or unavailable in object storage.");
  if (expectedBytes && byteLength !== Number(expectedBytes)) {
    throw new Error(`Stored MP4 size mismatch: expected ${expectedBytes} bytes, found ${byteLength}.`);
  }
  const contentType = result.ContentType || "";
  if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
    throw new Error(`Stored object has unsupported content type ${contentType}.`);
  }
  return { byteLength, contentType: contentType || "video/mp4", etag: String(result.ETag || "").replaceAll('"', "") };
}

export function videoStorageStatus() {
  return { configured: storageConfigured(), bucket: config.videoStorageBucket || null };
}
