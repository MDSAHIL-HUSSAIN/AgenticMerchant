# Agentic Merchant — Current Work Handoff

Last updated: 31 October 2026 (Asia/Calcutta)

This is the authoritative starting point for the next chat. Read it completely before changing either repository. Older handoff and planning documents are historical and may describe superseded image-only or local FFmpeg video designs.

## Current objective

AgenticMerchant now has two production paths:

1. The existing image workflow used by WhatsApp and the voice/dashboard client.
2. A new experimental Gemini Pro web-video workflow that generates an original MP4 through a logged-in local Chrome session, uploads that exact file unchanged to object storage, presents it for merchant review, and publishes it to Instagram/Facebook only after explicit approval.

The immediate next task is to commit, push, and deploy the dashboard repository, connect its callback URL to Agentic on Render, and run one complete dashboard-driven video test. Do not publish a real Reel merely to test the preview flow.

## Repositories and deployment state

### Agentic API

- Local path: `D:\E Drive\Project\Agentic`
- GitHub: `https://github.com/MDSAHIL-HUSSAIN/AgenticMerchant`
- Branch: `main`
- Current commit: `5c00bcb` (`video run`)
- `main` and `origin/main` were synchronized before this documentation update.
- Render service: `https://agentic-image-api.onrender.com`
- The new Agentic code has been pushed and deployed.
- Render reports `Gemini web video storage: ready`.
- A real Gemini-generated MP4 successfully reached the configured bucket.

### Dashboard

- Local path: `D:\E Drive\Project\dashboard`
- GitHub: `https://github.com/Codechefskj/dashboard`
- Current committed base: `bdb4593 Initial commit: Voice Studio dashboard`
- The inventory, chat UI, and Gemini-video changes are still local and have not yet been pushed/deployed.
- Expected working tree includes changes to `.env.example`, `README.md`, `package*.json`, `public/index.html`, `server.js`, inventory assets, `render.yaml`, and tests.
- The Agentic and dashboard directories are separate Git repositories. Commit and push them separately.

Always run `git status` in both repositories before editing. Preserve existing dashboard inventory work.

## New Gemini Pro web-video pipeline

### Final architecture

```text
Dashboard or authenticated API request
  -> Agentic API on Render
  -> durable Gemini video job in PostgreSQL
  -> local Windows BAT worker claims job
  -> local Qwen/Ollama writes one production-ready prompt
  -> Playwright controls a dedicated logged-in Gemini Chrome profile
  -> Gemini generates the complete video and audio
  -> worker downloads Gemini's original MP4
  -> read-only MP4 validation (no FFmpeg, edits, overlays or transcoding)
  -> Render issues a short-lived S3-compatible signed PUT URL
  -> worker uploads the original MP4 directly to object storage
  -> Render verifies object size and records SHA-256 plus metadata
  -> dashboard displays the public MP4 for review
  -> explicit merchant confirmation
  -> direct Instagram Reel and Facebook Page Reel publishing
```

Important decisions:

- The current Gemini video path does **not** call the image pipeline when no product image exists. The written product request is the source of truth.
- Render does not generate or proxy the MP4. The local worker downloads it and uploads it directly to object storage.
- The MP4 is not processed locally. `unchanged: true` means the Gemini download was hashed and uploaded without modification. Meta may perform its own platform transcoding after publication.
- Chrome uses a dedicated profile, opens minimized, and can remain minimized after the first interactive Google/Gemini login.
- The BAT window and local PC must remain running for jobs to be processed.
- CAPTCHA, reauthentication, quota errors, account confirmation, and Gemini UI changes are reported; the worker does not bypass Google controls.
- Automating the Gemini consumer website is experimental and can break when Google changes the UI. This is not an official Gemini video API integration.

### Agentic implementation files

- `apps/api/src/gemini-video-store.js` — PostgreSQL job store with SQLite local fallback and atomic worker leasing.
- `apps/api/src/gemini-video-storage.js` — signed S3/R2 upload tickets and object verification.
- `apps/api/src/gemini-video-publishers.js` — Instagram Reel and Facebook Page Reel publishers.
- `apps/api/src/gemini-video-jobs.js` — creation, leasing, progress, completion, review, retry, rejection, approval and publishing workflow.
- `apps/api/src/server.js` — internal and worker-authenticated endpoints.
- `apps/api/src/config.js` — database, storage, worker and Meta configuration.
- `apps/api/test/gemini-video-jobs.test.js` — workflow tests.
- `apps/gemini-video-worker/worker.mjs` — local worker loop.
- `apps/gemini-video-worker/qwen-story-planner.mjs` — Qwen creative direction.
- `apps/gemini-video-worker/gemini-browser.mjs` — Playwright/Chrome CDP Gemini automation.
- `apps/gemini-video-worker/mp4-validator.mjs` — read-only MP4 inspection.
- `apps/gemini-video-worker/start-video-worker.bat` — minimized dedicated Chrome plus worker launcher.
- `GEMINI_WEB_VIDEO_PIPELINE.md` — focused setup guide.
- `render.yaml` — Render PostgreSQL and environment declarations.

### API endpoints

Authenticated with `INTERNAL_SERVICE_TOKEN`:

```text
POST /api/gemini-video/jobs
GET  /api/gemini-video/jobs
GET  /api/gemini-video/jobs/:id
POST /api/gemini-video/jobs/:id/approve
POST /api/gemini-video/jobs/:id/reject
POST /api/gemini-video/jobs/:id/retry
```

Authenticated with `GEMINI_VIDEO_WORKER_TOKEN` (or internal token fallback):

```text
POST /api/video-worker/jobs/claim
POST /api/video-worker/jobs/:id/heartbeat
POST /api/video-worker/jobs/:id/progress
POST /api/video-worker/jobs/:id/upload-ticket
POST /api/video-worker/jobs/:id/complete
POST /api/video-worker/jobs/:id/fail
```

Normal job progression:

```text
QUEUED -> CLAIMED -> PLANNING -> GENERATING -> DOWNLOADING
-> UPLOADING -> AWAITING_APPROVAL -> PUBLISHING -> PUBLISHED
```

Partial/failure/review states include `RETRY`, `FAILED`, `REJECTED`, `PARTIALLY_PUBLISHED`, `PUBLISH_FAILED`, and `APPROVED` when no configured destination accepted the media.

Approval requires JSON containing `"confirm": true`. Approval immediately attempts real Meta publication, so do not call it during preview-only testing.

## Confirmed live test

The manually created job was:

```text
gvideo_bf3aaa24-14c6-44a6-b159-b18974ed5dae
```

Observed live sequence on Render:

```text
POST /api/gemini-video/jobs
POST /api/video-worker/jobs/:id/heartbeat
POST /api/video-worker/jobs/:id/progress
POST /api/video-worker/jobs/:id/upload-ticket
POST /api/video-worker/jobs/:id/complete
```

The video appeared in the bucket, proving the deployed API, worker authentication, local Qwen/Gemini automation, MP4 download/validation, signed upload, and storage verification path. After completion, the worker returned to its expected 15-second idle `claim` polling.

The test job used `sourceChannel: "api"`, so it will not automatically appear in the future dashboard. Create a new job through the deployed dashboard for the full callback/preview test.

### Render log interpretation

- Repeated `GET /health` entries are normal Render health probes.
- `WEB_CONCURRENCY=1` is the expected single Node process on the current instance.
- An early deployment logged `Gemini web video storage: not configured`; it was superseded after secrets were applied by a deployment logging `Gemini web video storage: ready`.
- `(demo mode)` refers to the older image/design provider behavior, not the Gemini web-video path.
- Node's SQLite experimental warning appears because the fallback module is imported. It does not by itself prove SQLite is selected.
- Confirm that Agentic Render has a valid `DATABASE_URL`. With it, Gemini video jobs use PostgreSQL; without it, the local SQLite fallback is ephemeral on Render.
- Current request logging records method/path but not the HTTP response status.

## Render configuration

Agentic requires these values (never commit their real contents):

```env
DATABASE_URL=<Render PostgreSQL connection>
DATABASE_SSL=true
INTERNAL_SERVICE_TOKEN=<shared with dashboard>
GEMINI_WEB_VIDEO_ENABLED=true
GEMINI_VIDEO_WORKER_TOKEN=<independent high-entropy worker token>
VIDEO_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
VIDEO_STORAGE_BUCKET=<bucket>
VIDEO_STORAGE_ACCESS_KEY_ID=<secret>
VIDEO_STORAGE_SECRET_ACCESS_KEY=<secret>
VIDEO_STORAGE_PUBLIC_BASE_URL=https://<public bucket or custom domain>
META_INSTAGRAM_ACCOUNT_ID=<professional Instagram account id>
META_FACEBOOK_PAGE_ID=<Facebook Page id>
META_PAGE_ACCESS_TOKEN=<Page token with Reel publishing permissions>
```

The object URL must be public HTTPS and fetchable by Meta. Keep historical `VIDEO_POST_ENABLED=false`; the new Gemini path is independently controlled by `GEMINI_WEB_VIDEO_ENABLED=true`.

## Local worker operation

Create `apps/gemini-video-worker/.env` from its example and set at minimum:

```env
AGENTIC_API_URL=https://agentic-image-api.onrender.com
GEMINI_VIDEO_WORKER_TOKEN=<same worker token as Render>
GEMINI_WORKER_ID=sahil-pc
CHROME_CDP_URL=http://127.0.0.1:9222
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_PLANNER_MODEL=qwen3:4b
QWEN_REQUIRED=true
WORKER_POLL_SECONDS=15
GEMINI_GENERATION_TIMEOUT_MINUTES=20
GEMINI_DOWNLOAD_DIR=./downloads
```

Requirements:

- Node.js 22 or newer.
- Google Chrome.
- Ollama running with `qwen3:4b` (or the configured Qwen model).
- A Gemini account with video-generation access, signed into the dedicated worker profile.
- Keep `start-video-worker.bat` running whenever new video jobs should be processed.

## Dashboard work already implemented locally

The dashboard was redesigned into a vertical GPT-style merchant conversation rather than a long inventory table.

Inventory behavior:

- Scanning is manual only; the removed 30-second automatic scan must not be reintroduced.
- A scan reports inventory totals and recommends the strongest eligible product instead of rendering an extremely long list.
- PostgreSQL persistence is supported for inventory and dashboard state.
- CSV seed/template assets exist locally. Previously imported data persists only when the deployed dashboard has a correctly configured durable `DATABASE_URL`; local or ephemeral files do not automatically transfer into a new Render database.
- The merchant can add/remove/update products and batches through the supported inventory paths, while campaign creation and publishing remain approval-gated.

Gemini video behavior:

- Voice/text commands containing generate/create/make/produce plus video route to the new Gemini video API.
- The dashboard does not invoke image generation as a prerequisite for video.
- It accepts `video.preview_ready` JSON callbacks at `POST /integrations/agentic/previews`.
- It displays a 9:16 HTML video preview with job state and checksum prefix.
- It provides **Approve & publish exact video**, **Generate another**, and **Reject** controls.
- Browser confirmation is required before the approval/publish request.
- Dashboard approval sends `confirm: true` to Agentic.

Relevant dashboard files:

- `D:\E Drive\Project\dashboard\server.js`
- `D:\E Drive\Project\dashboard\public\index.html`
- `D:\E Drive\Project\dashboard\public\inventory.js`
- `D:\E Drive\Project\dashboard\README.md`
- `D:\E Drive\Project\dashboard\render.yaml`
- `D:\E Drive\Project\dashboard\test\server.test.js`

## Dashboard deployment steps (next action)

1. In `D:\E Drive\Project\dashboard`, review all local changes and make sure no real secrets are present.
2. Run `npm test`.
3. Commit and push the dashboard repository.
4. Deploy/update its Render Blueprint using the root dashboard `render.yaml`.
5. Configure the dashboard service:

```env
AGENTIC_API_URL=https://agentic-image-api.onrender.com
INTERNAL_SERVICE_TOKEN=<exactly the same internal token as Agentic>
DASHBOARD_TOKEN=<strong private dashboard password>
DASHBOARD_MERCHANT_ID=dashboard
DATABASE_URL=<dashboard PostgreSQL connection>
DATABASE_SSL=true
SEED_INVENTORY_ON_EMPTY=true
```

6. After Render provides the dashboard URL, set this on the Agentic Render service:

```env
DASHBOARD_HANDOFF_URL=https://<dashboard-service>.onrender.com/integrations/agentic/previews
```

7. Restart/redeploy Agentic so the callback variable is loaded. Do not replace or remove `WHATSAPP_HANDOFF_URL`.
8. Keep the local BAT worker running and create a new video through the dashboard.
9. Confirm the dashboard receives and plays the bucket MP4.
10. Test reject/regenerate safely. Attempt approval only when a real Meta publish is intended.

## Validation completed before deployment

Agentic:

- New module syntax checks passed.
- Worker `npm run check` passed.
- Targeted Gemini and workflow tests: 10/10 passed.
- Full Agentic tests: 23/24 passed. The sole failure is the pre-existing historical local-video QA assertion `creates one autonomous exact-duration video preview with QA evidence`; it is unrelated to the new Gemini path.
- A real MP4 parser smoke test passed for H.264/AAC, 540×960, approximately 30 seconds, 24 FPS.
- Live Render startup and `/health` passed.
- Live worker-to-bucket generation/upload passed.

Dashboard:

- `npm test`: 6/6 passed at the time the new video integration was implemented.
- Dashboard server syntax and browser inline-script parsing passed.
- No live dashboard deployment or live callback test has occurred yet.

## Existing image and messaging systems

Do not break these while deploying video:

- WhatsApp image intake, clarification, preview, revision and approval remain available through the WhatsApp-specific endpoints and `WHATSAPP_HANDOFF_URL`.
- Dashboard image traffic uses dashboard-specific endpoints and `DASHBOARD_HANDOFF_URL`.
- `sourceChannel` separates WhatsApp, dashboard and direct API jobs.
- Image publishing adapters for Instagram/Facebook are separate from the new direct Meta Reel publishers.
- Real social posts must never be triggered without explicit authorization.
- The older local LTX/FramePack/FFmpeg/Remotion pipeline remains in the repository for historical/local use but is not the new Gemini workflow and is disabled on Render through `VIDEO_POST_ENABLED=false`.

## Known caveats

- Free Render instances can sleep, causing a cold-start delay of roughly 50 seconds or more.
- Gemini consumer UI selectors can change. Optional selector overrides exist in the worker `.env`.
- A public bucket URL working in the user's browser does not alone guarantee Meta can fetch it; Meta must be able to reach it anonymously over HTTPS.
- Meta publishing needs valid Page/Instagram identifiers, a professional Instagram account, correct permissions, and a valid Page token.
- The dashboard stores its own inventory/conversation/video display state. Agentic stores Gemini job state separately. Each deployed service needs durable PostgreSQL configuration.
- Never commit `.env`, tokens, Google profiles, downloaded account data, or storage credentials.

## Latest reliability and logging fix

Gemini once answered with a written production breakdown beginning `While this text interface cannot directly render and export an .mp4...` instead of generating a video. The old worker silently ignored failure to select video mode and then waited for a download button until the full timeout.

The current uncommitted fix changes this behavior:

- Selecting Gemini's **Create video** control is mandatory; failure stops before submitting ordinary chat.
- The worker tries a direct Create video control and the Gemini Tools menu, with `GEMINI_VIDEO_MODE_SELECTOR` available for UI changes.
- Instructional/stable text-only answers are detected after `GEMINI_TEXT_RESPONSE_GRACE_SECONDS` (default 20 seconds).
- Text-only and missing-video-mode errors are non-retryable, preventing repeated wasted generations.
- The BAT console prints timestamped structured events for claiming, planning, Chrome, video-mode selection, waiting, download, validation, upload, heartbeats and failures.
- Worker logs persist locally at `apps/gemini-video-worker/logs/worker.log` by default and are Git-ignored.
- Render logs now include HTTP response status and elapsed time, plus durable Gemini job-stage events and dashboard callback results.

After committing/pushing these Agentic changes, redeploy the Agentic Render API and restart the local BAT worker so both logging improvements take effect.

## Useful commands

Agentic:

```powershell
Set-Location 'D:\E Drive\Project\Agentic'
git status -sb
git log -3 --oneline
Set-Location 'D:\E Drive\Project\Agentic\apps\api'
node --test test/gemini-video-jobs.test.js test/workflow.test.js
```

Dashboard:

```powershell
Set-Location 'D:\E Drive\Project\dashboard'
git status -sb
npm test
```

Local worker:

```powershell
Set-Location 'D:\E Drive\Project\Agentic\apps\gemini-video-worker'
npm run check
```

## Suggested prompt for the next chat

```text
Read D:\E Drive\Project\Agentic\CURRENT_WORK_HANDOFF.md completely before acting. Then inspect git status in both D:\E Drive\Project\Agentic and D:\E Drive\Project\dashboard. Preserve all existing inventory and dashboard changes. Agentic commit 5c00bcb is already deployed, and a real Gemini MP4 successfully reached object storage. The next work is to validate, commit, push and deploy the dashboard, configure DASHBOARD_HANDOFF_URL on Agentic, and test a new dashboard-originated video preview. Do not reintroduce automatic inventory scanning, do not call the image pipeline for Gemini video, and do not publish a real Instagram/Facebook Reel without my explicit approval.
```
