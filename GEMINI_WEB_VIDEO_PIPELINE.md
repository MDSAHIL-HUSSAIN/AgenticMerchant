# Gemini Pro web video pipeline

This path uses the merchant's existing Gemini consumer subscription through a dedicated local Chrome profile. It does not use `GEMINI_API_KEY`, FFmpeg, the image generator, LTX, FramePack, RIFE, Real-ESRGAN, or ACE-Step.

## Runtime flow

1. The dashboard sends `POST /api/gemini-video/jobs` to Agentic on Render.
2. Render stores the job in PostgreSQL.
3. `apps/gemini-video-worker/start-video-worker.bat` keeps a local worker polling Render.
4. Local Qwen produces one complete video prompt.
5. Playwright connects to the dedicated minimized Chrome profile and submits the prompt to Gemini.
6. The original Gemini MP4 is downloaded and inspected with an MP4 parser. It is never edited or transcoded.
7. Render issues a short-lived S3-compatible signed PUT URL. The local worker uploads the original file directly to object storage.
8. Render verifies the stored object size and records the worker's SHA-256 checksum.
9. The dashboard receives a JSON preview event and shows the cloud MP4 with Approve, Generate another and Reject controls.
10. Only an explicit approval calls the direct Instagram Reel and Facebook Page Reel publishers.

Meta may transcode a published Reel. `unchanged: true` means the file downloaded from Gemini, hashed locally and uploaded to object storage was not modified by AgenticMerchant.

## Render configuration

The root `render.yaml` creates the PostgreSQL database and declares all required variables. Supply these secrets in Render:

```env
INTERNAL_SERVICE_TOKEN=<same value as dashboard>
GEMINI_VIDEO_WORKER_TOKEN=<new independent high-entropy token>
VIDEO_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
VIDEO_STORAGE_BUCKET=agentic-videos
VIDEO_STORAGE_ACCESS_KEY_ID=<R2/S3 key>
VIDEO_STORAGE_SECRET_ACCESS_KEY=<R2/S3 secret>
VIDEO_STORAGE_PUBLIC_BASE_URL=https://<public bucket or custom domain>
META_INSTAGRAM_ACCOUNT_ID=<professional Instagram account id>
META_FACEBOOK_PAGE_ID=<Facebook Page id>
META_PAGE_ACCESS_TOKEN=<Page token with publishing permissions>
```

The storage URL must be public HTTPS and allow Meta to fetch the MP4. Keep `VIDEO_POST_ENABLED=false`; that flag controls the historical local GPU/FFmpeg pipeline. The new path is controlled separately by `GEMINI_WEB_VIDEO_ENABLED=true`.

## Local PC setup

1. Copy `apps/gemini-video-worker/.env.example` to `apps/gemini-video-worker/.env`.
2. Set the Render URL and the exact same `GEMINI_VIDEO_WORKER_TOKEN` used on Render.
3. Ensure Ollama is running with the configured Qwen model.
4. Double-click `start-video-worker.bat`.
5. On first use, restore its dedicated Chrome window and sign in to Gemini. Chrome can remain minimized afterward.

The worker stops and reports a retryable failure if Gemini changes its UI, requests reauthentication, produces an incompatible MP4, or the subscription has no remaining generation quota. It does not bypass Google security controls.

## Merchant command

In Voice Studio, a request containing a phrase such as `generate a video` is routed to this pipeline. No image is automatically generated when the request has no product image. The written request becomes the product source of truth.
