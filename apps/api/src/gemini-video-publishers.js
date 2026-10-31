import { config } from "./config.js";

const graphBase = () => `https://graph.facebook.com/${encodeURIComponent(config.metaGraphVersion)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function graphRequest(url, { method = "GET", params = {}, headers = {} } = {}) {
  const body = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null));
  const response = await fetch(url, {
    method,
    headers: method === "GET" ? headers : { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(90_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error?.message || `Meta request failed with HTTP ${response.status}.`);
  return payload;
}

export async function publishInstagramReel(job) {
  if (!config.metaInstagramAccountId || !config.metaPageAccessToken) {
    return { channel: "instagram", status: "NOT_CONFIGURED" };
  }
  const created = await graphRequest(`${graphBase()}/${encodeURIComponent(config.metaInstagramAccountId)}/media`, {
    method: "POST",
    params: {
      media_type: "REELS",
      video_url: job.video.publicUrl,
      caption: job.caption || job.request?.caption || "",
      share_to_feed: "true",
      access_token: config.metaPageAccessToken
    }
  });
  let status;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(attempt ? 5000 : 1500);
    const url = new URL(`${graphBase()}/${encodeURIComponent(created.id)}`);
    url.searchParams.set("fields", "status_code,status");
    url.searchParams.set("access_token", config.metaPageAccessToken);
    status = await graphRequest(url);
    if (["FINISHED", "PUBLISHED"].includes(status.status_code)) break;
    if (["ERROR", "EXPIRED"].includes(status.status_code)) throw new Error(`Instagram processing failed: ${status.status || status.status_code}.`);
  }
  if (!["FINISHED", "PUBLISHED"].includes(status?.status_code)) throw new Error("Instagram did not finish processing the Reel before the timeout.");
  const published = await graphRequest(`${graphBase()}/${encodeURIComponent(config.metaInstagramAccountId)}/media_publish`, {
    method: "POST",
    params: { creation_id: created.id, access_token: config.metaPageAccessToken }
  });
  return { channel: "instagram", status: "DELIVERED", mediaId: published.id, containerId: created.id, publishedAt: new Date().toISOString() };
}

export async function publishFacebookReel(job) {
  if (!config.metaFacebookPageId || !config.metaPageAccessToken) {
    return { channel: "facebook", status: "NOT_CONFIGURED" };
  }
  const started = await graphRequest(`${graphBase()}/${encodeURIComponent(config.metaFacebookPageId)}/video_reels`, {
    method: "POST",
    params: { upload_phase: "start", access_token: config.metaPageAccessToken }
  });
  if (!started.video_id || !started.upload_url) throw new Error("Facebook did not return a Reel upload session.");
  const uploaded = await graphRequest(started.upload_url, {
    method: "POST",
    headers: { Authorization: `OAuth ${config.metaPageAccessToken}`, file_url: job.video.publicUrl }
  });
  if (uploaded.success === false) throw new Error("Facebook rejected the hosted MP4 upload.");
  const finished = await graphRequest(`${graphBase()}/${encodeURIComponent(config.metaFacebookPageId)}/video_reels`, {
    method: "POST",
    params: {
      upload_phase: "finish",
      video_id: started.video_id,
      video_state: "PUBLISHED",
      description: job.caption || job.request?.caption || "",
      access_token: config.metaPageAccessToken
    }
  });
  return { channel: "facebook", status: "DELIVERED", videoId: started.video_id, result: finished, publishedAt: new Date().toISOString() };
}

export async function publishGeminiVideo(job) {
  const targets = new Set(job.targetChannels || []);
  const tasks = [];
  if (targets.has("instagram")) tasks.push(publishInstagramReel(job).catch(error => ({ channel: "instagram", status: "FAILED", error: error.message })));
  if (targets.has("facebook")) tasks.push(publishFacebookReel(job).catch(error => ({ channel: "facebook", status: "FAILED", error: error.message })));
  return Promise.all(tasks);
}
