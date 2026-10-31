import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl, ssl: config.databaseSsl ? { rejectUnauthorized: false } : false })
  : null;

let sqlite = null;
if (!pool) {
  mkdirSync(dirname(config.stateDbPath), { recursive: true });
  sqlite = new DatabaseSync(config.stateDbPath);
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS gemini_video_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      available_at TEXT NOT NULL,
      lease_expires_at TEXT,
      claimed_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gemini_video_jobs_claim_idx
      ON gemini_video_jobs(status, available_at, lease_expires_at);
  `);
}

let readyPromise;
export function initGeminiVideoStore() {
  if (readyPromise) return readyPromise;
  readyPromise = pool ? pool.query(`
    CREATE TABLE IF NOT EXISTS gemini_video_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      payload JSONB NOT NULL,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_expires_at TIMESTAMPTZ,
      claimed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gemini_video_jobs_claim_idx
      ON gemini_video_jobs(status, available_at, lease_expires_at);
  `).then(() => ({ provider: "postgres" })) : Promise.resolve({ provider: "sqlite" });
  return readyPromise;
}

function parse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function hydrate(row) {
  if (!row) return null;
  const job = parse(row.payload);
  if (!job) return null;
  return {
    ...job,
    status: row.status || job.status,
    availableAt: row.available_at ? new Date(row.available_at).toISOString() : job.availableAt,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    claimedBy: row.claimed_by || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : job.createdAt,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : job.updatedAt
  };
}

export async function insertGeminiVideoJob(job) {
  await initGeminiVideoStore();
  if (pool) {
    const result = await pool.query(`
      INSERT INTO gemini_video_jobs (id, status, payload, available_at, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6)
      RETURNING *
    `, [job.id, job.status, JSON.stringify(job), job.availableAt, job.createdAt, job.updatedAt]);
    return hydrate(result.rows[0]);
  }
  sqlite.prepare(`INSERT INTO gemini_video_jobs
    (id, status, payload, available_at, lease_expires_at, claimed_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`)
    .run(job.id, job.status, JSON.stringify(job), job.availableAt, job.createdAt, job.updatedAt);
  return getGeminiVideoJob(job.id);
}

export async function getGeminiVideoJob(id) {
  await initGeminiVideoStore();
  if (pool) return hydrate((await pool.query("SELECT * FROM gemini_video_jobs WHERE id = $1", [String(id)])).rows[0]);
  return hydrate(sqlite.prepare("SELECT * FROM gemini_video_jobs WHERE id = ?").get(String(id)));
}

export async function saveGeminiVideoJob(job, { preserveLease = false } = {}) {
  await initGeminiVideoStore();
  job.updatedAt = new Date().toISOString();
  if (pool) {
    const result = await pool.query(`
      UPDATE gemini_video_jobs SET status = $2, payload = $3::jsonb, available_at = $4,
        lease_expires_at = CASE WHEN $5 THEN lease_expires_at ELSE $6 END,
        claimed_by = CASE WHEN $5 THEN claimed_by ELSE $7 END, updated_at = $8
      WHERE id = $1 RETURNING *
    `, [job.id, job.status, JSON.stringify(job), job.availableAt || job.updatedAt, preserveLease,
      job.leaseExpiresAt || null, job.claimedBy || null, job.updatedAt]);
    return hydrate(result.rows[0]);
  }
  const previous = sqlite.prepare("SELECT lease_expires_at, claimed_by FROM gemini_video_jobs WHERE id = ?").get(job.id) || {};
  sqlite.prepare(`UPDATE gemini_video_jobs SET status = ?, payload = ?, available_at = ?,
    lease_expires_at = ?, claimed_by = ?, updated_at = ? WHERE id = ?`)
    .run(job.status, JSON.stringify(job), job.availableAt || job.updatedAt,
      preserveLease ? previous.lease_expires_at : (job.leaseExpiresAt || null),
      preserveLease ? previous.claimed_by : (job.claimedBy || null), job.updatedAt, job.id);
  return getGeminiVideoJob(job.id);
}

export async function claimGeminiVideoJob(workerId, leaseSeconds) {
  await initGeminiVideoStore();
  const claimedAt = new Date();
  const leaseExpiresAt = new Date(claimedAt.getTime() + leaseSeconds * 1000).toISOString();
  if (pool) {
    const result = await pool.query(`
      WITH candidate AS (
        SELECT id FROM gemini_video_jobs
        WHERE status IN ('QUEUED', 'RETRY') AND available_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE gemini_video_jobs AS jobs
      SET status = 'CLAIMED', claimed_by = $1, lease_expires_at = $2, updated_at = NOW(),
          payload = jsonb_set(jsonb_set(jobs.payload, '{status}', '"CLAIMED"'::jsonb), '{updatedAt}', to_jsonb(NOW()::text))
      FROM candidate WHERE jobs.id = candidate.id RETURNING jobs.*
    `, [workerId, leaseExpiresAt]);
    return hydrate(result.rows[0]);
  }
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = sqlite.prepare(`SELECT * FROM gemini_video_jobs
      WHERE status IN ('QUEUED', 'RETRY') AND available_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      ORDER BY created_at ASC LIMIT 1`).get(claimedAt.toISOString(), claimedAt.toISOString());
    if (!row) { sqlite.exec("COMMIT"); return null; }
    const job = hydrate(row);
    job.status = "CLAIMED";
    job.claimedBy = workerId;
    job.leaseExpiresAt = leaseExpiresAt;
    job.updatedAt = claimedAt.toISOString();
    sqlite.prepare(`UPDATE gemini_video_jobs SET status = 'CLAIMED', payload = ?, claimed_by = ?,
      lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(job), workerId, leaseExpiresAt, job.updatedAt, job.id);
    sqlite.exec("COMMIT");
    return job;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

export async function heartbeatGeminiVideoJob(id, workerId, leaseSeconds) {
  await initGeminiVideoStore();
  const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  if (pool) {
    const result = await pool.query(`UPDATE gemini_video_jobs SET lease_expires_at = $3, updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2 AND status IN ('CLAIMED','PLANNING','GENERATING','DOWNLOADING','UPLOADING') RETURNING *`, [id, workerId, lease]);
    return hydrate(result.rows[0]);
  }
  sqlite.prepare(`UPDATE gemini_video_jobs SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND claimed_by = ? AND status IN ('CLAIMED','PLANNING','GENERATING','DOWNLOADING','UPLOADING')`)
    .run(lease, new Date().toISOString(), id, workerId);
  return getGeminiVideoJob(id);
}

export async function listGeminiVideoJobs({ merchantId = "", limit = 30 } = {}) {
  await initGeminiVideoStore();
  const rows = pool
    ? (await pool.query("SELECT * FROM gemini_video_jobs ORDER BY created_at DESC LIMIT $1", [Math.max(1, Math.min(100, Number(limit) || 30))])).rows
    : sqlite.prepare("SELECT * FROM gemini_video_jobs ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit) || 30)));
  return rows.map(hydrate).filter(job => job && (!merchantId || job.merchantId === merchantId));
}
