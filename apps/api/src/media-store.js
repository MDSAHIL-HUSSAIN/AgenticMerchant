import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { loadMediaRecords, persistMediaRecord } from "./state-db.js";

const metadata = new Map(loadMediaRecords().map(record => [record.id, record]));
const safeName = value => String(value || "asset").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 90);

function extensionFor(mimeType) {
  const known = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/webm": "webm"
    ,"video/mp4": "mp4"
    ,"video/quicktime": "mov"
    ,"video/webm": "webm"
    ,"application/json": "json"
    ,"text/vtt": "vtt"
  };
  return known[mimeType] || "bin";
}

export async function storeMedia({ bytes, mimeType, filename, kind = "unknown", metadata: extra = {} }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("Media bytes are required.");
  const id = `asset_${crypto.randomUUID()}`;
  const extension = extensionFor(mimeType);
  const storedName = `${id}.${extension}`;
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, storedName), bytes);
  const record = {
    id,
    kind,
    mimeType: mimeType || "application/octet-stream",
    filename: safeName(filename || storedName),
    storedName,
    byteLength: bytes.length,
    createdAt: new Date().toISOString(),
    ...extra
  };
  metadata.set(id, record);
  persistMediaRecord(record);
  return { ...record };
}

export function getMediaRecord(id) {
  const record = metadata.get(String(id));
  return record ? { ...record } : null;
}

export function updateMediaRecord(id, changes = {}) {
  const existing = metadata.get(String(id));
  if (!existing) throw new Error("Asset not found.");
  const updated = { ...existing, ...changes, id: existing.id, storedName: existing.storedName };
  metadata.set(existing.id, updated);
  persistMediaRecord(updated);
  return { ...updated };
}

export async function readMedia(id) {
  const record = metadata.get(String(id));
  if (!record) throw new Error("Asset not found.");
  return { record: { ...record }, bytes: await readFile(join(config.dataDir, record.storedName)) };
}

export function getMediaPath(id) {
  const record = metadata.get(String(id));
  if (!record) throw new Error("Asset not found.");
  return join(config.dataDir, record.storedName);
}

export async function mediaFileInfo(id) {
  const record = metadata.get(String(id));
  if (!record) throw new Error("Asset not found.");
  const path = join(config.dataDir, record.storedName);
  const details = await stat(path);
  return { record: { ...record }, path, size: details.size };
}

export function createMediaReadStream(id, options = {}) {
  return createReadStream(getMediaPath(id), options);
}

export function listMedia(ids = []) {
  return ids.map(getMediaRecord).filter(Boolean);
}
