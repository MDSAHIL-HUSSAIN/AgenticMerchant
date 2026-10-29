import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

mkdirSync(dirname(config.stateDbPath), { recursive: true });
const database = new DatabaseSync(config.stateDbPath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS product_drafts (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_requests (
    idempotency_key TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const upsertJob = database.prepare(`
  INSERT INTO jobs (id, type, status, payload, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    status = excluded.status,
    payload = excluded.payload,
    updated_at = excluded.updated_at
`);
const upsertMedia = database.prepare(`
  INSERT INTO media_assets (id, payload, created_at)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
`);
const upsertDraft = database.prepare(`
  INSERT INTO product_drafts (id, payload, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
`);
const insertIntegrationResponse = database.prepare(`
  INSERT OR IGNORE INTO integration_requests (idempotency_key, response, created_at)
  VALUES (?, ?, ?)
`);

function parseRows(rows) {
  return rows.flatMap(row => {
    try { return [JSON.parse(row.payload)]; } catch { return []; }
  });
}

export function loadJobs() {
  return parseRows(database.prepare("SELECT payload FROM jobs").all());
}

export function persistJob(job) {
  upsertJob.run(job.id, job.type || "IMAGE_POST", job.status || "UNKNOWN", JSON.stringify(job), job.updatedAt || new Date().toISOString());
}

export function loadMediaRecords() {
  return parseRows(database.prepare("SELECT payload FROM media_assets").all());
}

export function persistMediaRecord(record) {
  upsertMedia.run(record.id, JSON.stringify(record), record.createdAt || new Date().toISOString());
}

export function loadDrafts() {
  return parseRows(database.prepare("SELECT payload FROM product_drafts").all());
}

export function persistDraft(draft) {
  upsertDraft.run(draft.id, JSON.stringify(draft), draft.updatedAt || new Date().toISOString());
}

export function getIntegrationResponse(key) {
  const row = database.prepare("SELECT response FROM integration_requests WHERE idempotency_key = ?").get(String(key));
  if (!row) return null;
  try { return JSON.parse(row.response); } catch { return null; }
}

export function persistIntegrationResponse(key, response) {
  insertIntegrationResponse.run(String(key), JSON.stringify(response), new Date().toISOString());
}
