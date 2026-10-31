# Autonomous Product Design Agent

This prototype contains the image workflow plus an autonomous local video-post workflow:

1. multimodal product drafts from text, images and audio;
2. an Adobe-independent SVG/Sharp renderer that creates the strongest prototype design;
3. deterministic quality gates, automatic repair, and an opt-in rendered-image Gemini review.
4. versioned approve/edit/reject handling and binary WhatsApp preview handoff;
5. locked approval, platform exports and binary publishing handoff;
6. an optional Adobe manual-edit queue that returns edited renditions as new revisions.
7. a persistent, queued 8–60 second product-film pipeline with autonomous planning, controlled keyframes, generated motion, audio, temporal QA, revisions, approval, and exports.

The Adobe Express add-on remains available as the optional editable-canvas bridge. Automatic preview creation no longer depends on Adobe Express being open.

## Current deployed status (31 October 2026)

The Agentic API at `https://agentic-image-api.onrender.com` now includes an experimental Gemini Pro web-video path in addition to the existing image and historical local-video systems. Agentic commit `5c00bcb` is pushed and deployed. A live test successfully created a job, leased it to the local Windows worker, generated and downloaded the Gemini MP4, issued a signed storage upload, verified the uploaded object, and placed the job into merchant review.

The companion dashboard implementation is complete locally but still needs to be committed, pushed and deployed from `D:\E Drive\Project\dashboard`. After it is live, configure Agentic's `DASHBOARD_HANDOFF_URL` with the dashboard's `/integrations/agentic/previews` endpoint. See `CURRENT_WORK_HANDOFF.md` for the authoritative deployment state and next actions, and `GEMINI_WEB_VIDEO_PIPELINE.md` for focused worker setup.

### Gemini web-video flow

```text
dashboard request
-> Render/PostgreSQL job
-> local BAT worker
-> Qwen prompt planning
-> Playwright + dedicated logged-in Gemini Chrome profile
-> original Gemini MP4 download
-> read-only MP4 validation
-> direct worker-to-object-storage upload
-> dashboard preview
-> explicit merchant approval
-> Instagram/Facebook Reel publication
```

This path does not invoke the image pipeline when no product image exists and does not use FFmpeg, editing, transitions, overlays, LTX or FramePack. Chrome opens minimized and may remain minimized after the first interactive login. The local PC, Chrome profile, Ollama/Qwen and BAT worker must remain available while jobs are processed. Automating the consumer Gemini website is experimental and subject to Google's UI, account controls, quotas and terms.

The worker requires Gemini's **Create video** mode before it submits a prompt. If that control is unavailable, or Gemini returns a production breakdown/instructions instead of a downloadable MP4, the job fails clearly and does not wait indefinitely or repeat a non-retryable attempt. Timestamped worker events are shown in the BAT window and saved to `apps/gemini-video-worker/logs/worker.log`; Render logs include job stages, callback outcomes, HTTP status and request duration.

## Current pipeline

```text
WhatsApp/backend multipart message
    ├── metadata and text
    ├── product/reference/logo images
    └── audio plus optional transcript
             │
             ▼
Product draft
    ├── merge messages across the conversation
    ├── classify media roles
    ├── transcribe locally when enabled
    └── return clarification questions when uncertain
             │
             ▼
One bounded design specification
             │
             ▼
Local SVG + Sharp PNG renderer
             │
             ▼
Bounds / overflow / overlap / rendered-image QA
             │
             ▼
Private preview asset IDs and binary image endpoints
```

## Install and run

### Render deployment for the image API

The root `render.yaml` deploys only `apps/api` with the local video worker disabled. Uploaded images and SQLite state use Render's ephemeral `/tmp` storage on the free plan, which is suitable for integration testing but not durable production storage. Configure `INTERNAL_SERVICE_TOKEN` during Blueprint creation and deploy the updated WhatsApp receiver before testing.

```powershell
npm run install:all
npm run dev:api
```

The API defaults to `http://localhost:8787`.

## Temporary visual demo studio

The API now serves a local end-to-end review interface at:

```text
http://localhost:8787
```

Start it with:

```powershell
npm run demo
```

The demo accepts a product brief plus optional product/reference images and creates either one best campaign image or one autonomously directed product film. Both support revisions, approval, and platform exports. It uses the same private binary asset endpoints as the integration pipeline. With the default `DEMO_MODE=true`, it does not call external image search, Gemini, Cloudflare or other quota-limited providers.

## Live image pipeline

Set `DEMO_MODE=false` to enable live product discovery and provider-backed art direction. For a searched product image, configure `SERPAPI_KEY`, `GEMINI_API_KEY`, and `REMOVE_BG_API_KEY`. The selected design image is downloaded once, sent to remove.bg as a product, stored as a transparent PNG, and reused by rendering and later revisions. A removal failure is logged and falls back to the original selected image instead of failing the job. `REMOVE_BG_SIZE=auto` requests the best resolution available for the account.

`TAVILY_API_KEY` adds factual product research. `PIXABAY_API_KEY` supplies optional stock scene backgrounds. `CLOUDFLARE_ACCOUNT_ID` plus `CLOUDFLARE_API_TOKEN` generates original scene backgrounds. These three integrations are optional; native design geometry remains available when they are absent. `AUTONOMOUS_VISION_QA=true` is recommended when Gemini is configured so the final composition receives an additional visual review.

## Autonomous video posts

Queue a vertical film from an existing product draft:

```text
POST /api/product-drafts/:id/video
```

The optional JSON body accepts `durationSeconds` (8–60), `fps`, `aspectRatio`, `narrationEnabled`, and `autonomousDuration`. When no duration is supplied, the local director chooses 12–60 seconds from the category and story. Read progress from `GET /api/video-jobs/:id` or the SSE endpoint `GET /api/video-jobs/:id/events`. Revision, approval, cancellation, and retry endpoints live under `/api/video-jobs/:id/*`; the generic job feedback and approval routes also dispatch video jobs correctly.

The isolated Python worker uses LTX-Video 2B 0.9.6 distilled as its primary motion engine at 576×1024 and the checkpoint's recommended 8 steps. Qwen chooses 33–121 frames, 16–30 FPS and two or three candidate takes independently for each generative shot. It also chooses 5–12 shots, product staging, camera direction, edit motion and transitions. Background removal lets rigid products move through designed environments without repeatedly showing the source photograph. FramePack remains an optional fallback. Real-ESRGAN can enhance accepted generated scenes, while ACE-Step creates an original category-specific score aligned to edit points; optional narration uses Kokoro.

Every director plan is upgraded to editable timeline schema v2. The worker returns the accepted per-shot footage and its candidate-selection evidence, then Remotion assembles reusable product-reveal, macro-inspection, feature-callout, hero and brand-finale compositions. FFmpeg remains responsible for model preparation, the synchronized audio bed, technical encoding and delivery variants. The preview pass renders at 540×960. Approval reruns the accepted timeline at 1080×1920 before producing Instagram/Facebook reels, square and portrait variants, and a poster.

Every real product image also has a guaranteed local video path. If both LTX and FramePack are unavailable or reject a shot, the worker converts that shot's product-matched keyframe into a controlled camera, crop, exposure and light animation. RIFE and Real-ESRGAN failures retain the accepted source clip, and the built-in original score follows the planned BPM and musical key when ACE-Step is unavailable. These fallbacks remain represented in motion QA and the editable timeline rather than aborting the complete product film.

`VIDEO_FAST_TEMPLATE_MODE=true` is the default delivery mode. It bypasses Qwen direction, LTX, FramePack, RIFE, Real-ESRGAN, ACE-Step, Qwen Vision and Remotion. A six-shot, 15-second template uses the real product image in reusable macro, lateral, diagonal, locked-light, pull-back and precision-track treatments, then FFmpeg adds transitions, product copy, sound design and a beat/key-matched original score. Explicit durations are still honored. Set the flag to `false` to restore the slower generative pipeline.

After the preview render, representative frames from every shot are extracted at the entrance, midpoint and exit. Qwen3-VL evaluates product presence, identity, empty space, crop, typography, continuity, lighting and slideshow-like editing. Deterministic checks catch black frames and nearly frozen shots even when the vision model is unavailable. High-severity findings map to bounded, issue-specific repairs; only affected keyframes are rebuilt and unchanged LTX clips are reused through their content cache. The job saves the editable timeline, accepted and rejected motion candidates, visual-review reports and repair history as production artifacts.

A real uploaded product image is mandatory. Generative shots are animated from the planned product motion plates with LTX and automatically scored for identity, motion and sharpness. The job fails clearly when the required source is unavailable; it does not silently publish a placeholder slideshow.

Set `VIDEO_EDITOR_ENGINE=remotion` to use the editable editor layer, `VIDEO_VISUAL_QA=true` to enable Qwen visual review, `OLLAMA_VISION_MODEL=qwen3-vl:2b` to select the local evaluator, and `MAX_VIDEO_VISUAL_REPAIRS=2` to bound automatic revisions. If Remotion or Qwen Vision is temporarily unavailable, the pipeline records the reason and retains the existing FFmpeg render and deterministic inspection path.

Inspect local model and executable readiness with `GET /api/video-worker/health`. Run a full offline render/approval/export check with `npm run smoke:video`; omit `SMOKE_VIDEO_DURATION` to let Qwen direct the runtime, or set it to any supported 8–60 second value.

The Adobe add-on remains available with:

```powershell
npm run build:addon
npm run start:addon
```

## Multimodal intake

Send `multipart/form-data` to:

```text
POST /api/product-drafts/messages
```

The `metadata` field is JSON:

```json
{
  "merchantId": "merchant_123",
  "conversationId": "conversation_789",
  "productId": "product_456",
  "productName": "Cotton Kurti",
  "brand": "Kavya Boutique",
  "category": "Women's clothing",
  "price": 799,
  "features": ["100% cotton", "festive wear"],
  "colors": ["rust"],
  "sizes": ["M", "L"],
  "creativeDirection": "warm festive premium",
  "mediaRoles": {
    "product_image": "PRIMARY_PRODUCT",
    "inspiration": "STYLE_REFERENCE"
  },
  "audioTranscripts": {
    "voice_note": "Cotton kurti, price 799, sizes M and L"
  }
}
```

Attach files under any field name. Descriptive names such as `product_image`, `logo`, `detail`, and `inspiration` improve deterministic classification. When an image remains ambiguous, the response has status `NEEDS_CLARIFICATION` and includes a question.

Resolve it with:

```text
POST /api/product-drafts/:id/clarifications
```

```json
{
  "questionId": "...",
  "answer": "product"
}
```

Create the rendered campaign design with:

```text
POST /api/product-drafts/:id/design
```

The response contains one private preview asset. Retrieve its actual bytes using:

```text
GET /api/assets/:assetId/content
```

No public image URL is required.

## Approval and revision loop

### Integrated WhatsApp image workflow

The teammate service is included at `apps/whatsapp-bot`. It now accepts signed inbound Meta image/text events, stores them in a PostgreSQL-backed integration queue, downloads product media asynchronously, and calls Agentic through dedicated Bearer-authenticated routes:

```http
POST /api/integrations/whatsapp/messages
POST /api/integrations/whatsapp/jobs/:jobId/feedback
```

Agentic returns previews to:

```http
POST /whatsapp/integrations/agentic/previews
```

Configure both services with the same private `INTERNAL_SERVICE_TOKEN`, set `AGENTIC_API_URL` in the bot, and set Agentic's `WHATSAPP_HANDOFF_URL` to the bot preview endpoint. The Meta verification token remains separate. See `apps/whatsapp-bot/README.md` for migration and deployment steps.

Deliver the current preview pack as multipart binary files to the configured WhatsApp service:

```text
POST /api/jobs/:jobId/deliver-preview
```

Configure its receiving endpoint with `WHATSAPP_HANDOFF_URL`. If it is empty, the endpoint reports `NOT_CONFIGURED` without losing the preview assets.

WhatsApp feedback is accepted as JSON or multipart text, audio and images:

```text
POST /api/jobs/:jobId/feedback
```

Supported actions are `APPROVE_ALL`, `APPROVE_SELECTED`, `EDIT_SELECTED`, `REJECT_SELECTED`, `REJECT_ALL`, and `EDIT_MANUALLY`. Every automatic edit or rejection creates a new immutable revision and reruns rendering and QA. Supply `messageId` or `idempotencyKey` to prevent duplicate processing.

### Voice dashboard integration

The dashboard uses separate integration routes for the existing image workflow while sharing the same draft, clarification, rendering, revision, approval and publishing engine:

```text
POST /api/integrations/dashboard/messages
POST /api/integrations/dashboard/jobs/:id/feedback
```

Configure `DASHBOARD_HANDOFF_URL` with the dashboard's `/integrations/agentic/previews` URL. Jobs carry `sourceChannel` and are routed only to their originating service: dashboard previews never use `WHATSAPP_HANDOFF_URL`, and WhatsApp previews never use `DASHBOARD_HANDOFF_URL`. Every approved image automatically publishes to each configured Facebook and Instagram connector and creates a Shopify draft; image `targetChannels` cannot disable these destinations. Gemini video targets remain limited to Instagram and Facebook.

The same dashboard also supports the independent Gemini web-video job endpoints under `/api/gemini-video/jobs`. It accepts `video.preview_ready` callbacks, renders the public 9:16 MP4 for review, and offers approve/publish, regenerate and reject actions. Video approval requires an explicit `confirm: true` and immediately attempts the configured Meta Reel publishers.

## Final exports and publishing handoff

Approval can also be called directly:

```text
POST /api/jobs/:jobId/approve
```

Approved designs are locked and exported as:

- 2160×2160 master;
- 1600×1600 Shopify;
- 1080×1080 Instagram square;
- 1080×1350 Instagram portrait;
- 1200×630 Facebook feed.

Approval automatically transfers all final files through the configured publishing handoffs. The following endpoint remains available only as an idempotent retry/recovery operation:

```text
POST /api/jobs/:jobId/deliver-final
```

Configure the receiver with `PUBLISHING_HANDOFF_URL`. Both handoff adapters can use `INTERNAL_SERVICE_TOKEN` for a bearer token and send a stable idempotency key.

### Existing Facebook StoreBot integration

The prototype can also work with the Facebook teammate's current publisher without changing that repository. Configure `FACEBOOK_CLOUDINARY_CLOUD_NAME`, `FACEBOOK_CLOUDINARY_API_KEY`, `FACEBOOK_CLOUDINARY_API_SECRET`, `FACEBOOK_PUBLISH_URL`, and `FACEBOOK_PUBLISH_SECRET`. On approval, the service uploads the one approved `facebook_feed` PNG to the dedicated Facebook Cloudinary account and only then calls the existing `/api/publish` trigger. Upload and publishing are sequential because the existing publisher selects the newest untagged Cloudinary image. When `PUBLISHING_HANDOFF_URL` is configured, the same approval sends the complete platform-tagged binary export set to the shared publishing receiver for the other services.

For the teammate's Instagram image publisher, configure `INSTAGRAM_PUBLISH_URL` and `INSTAGRAM_PUBLISH_API_KEY`. Approval sends only the `instagram_portrait` export as multipart field `file` with the shared key in `X-API-Key`. The teammate service generates the caption when none is supplied and returns `instagram_post_id`, which Agentic records in the publishing handoff. Reel delivery remains disabled in this adapter until the video workflow is explicitly integrated.

### StoreBot Shopify integration

Configure `SHOPIFY_CLOUDINARY_CLOUD_NAME`, `SHOPIFY_CLOUDINARY_API_KEY`, `SHOPIFY_CLOUDINARY_API_SECRET`, `SHOPIFY_PUBLISH_URL`, and `SHOPIFY_PUBLISH_SECRET` with the same Cloudinary account and webhook secret used by StoreBot Shopify. After explicit approval of any image, Agentic uploads only the approved `shopify` 1600×1600 PNG and sends its Cloudinary public ID plus product cost to StoreBot. Agentic never supplies a selling price; StoreBot calculates it and creates the Shopify product as `DRAFT`. Dashboard inventory provides its saved cost automatically. If no cost is available, Agentic supplies a stable placeholder cost so approval never waits for cost input.

## Optional Adobe manual editing

`EDIT_MANUALLY` creates an Adobe queue item. In add-on version 1.2.0:

1. select **Load pending edit**;
2. the add-on claims the job and recreates it with native Adobe text, image and shape elements;
3. edit the page normally;
4. select **Save edited revision**;
5. the add-on renders the exact page and uploads the image bytes;
6. the backend validates the rendition and creates a new approval revision.

Adobe queue endpoints are:

```text
POST /api/jobs/:jobId/adobe-edit
GET  /api/adobe/jobs/pending
POST /api/adobe/jobs/:id/claim
GET  /api/adobe/jobs/:id/specification
POST /api/adobe/jobs/:id/page
POST /api/adobe/jobs/:id/result
```

## Optional local audio transcription

Install the local Python dependency:

```powershell
python -m pip install -r apps/api/requirements-whisper.txt
```

Then configure:

```dotenv
LOCAL_WHISPER_ENABLED=true
LOCAL_WHISPER_MODEL=small
PYTHON_COMMAND=python
```

The first Faster Whisper run downloads the selected model. Leave it disabled when the WhatsApp service already supplies a transcript.

## Optional live visual intelligence

Provider-backed features are explicitly opt-in so ordinary local tests cannot consume free quotas:

```dotenv
AUTONOMOUS_MEDIA_ANALYSIS=true
AUTONOMOUS_VISION_QA=true
AUTONOMOUS_REVISION_AI=true
```

`AUTONOMOUS_MEDIA_ANALYSIS` classifies uploaded images, `AUTONOMOUS_VISION_QA` critiques the actual rendered pack, and `AUTONOMOUS_REVISION_AI` interprets open-ended merchant revision language. They require `GEMINI_API_KEY`; all remain disabled by default to protect quota and fall back to deterministic behavior.

Existing live adapters remain available for SerpApi, Tavily, Pixabay and Cloudflare Workers AI. Missing providers degrade to local planning, geometry and merchant-supplied assets.

## Quality loop

Every locally rendered page is checked for:

- canvas and footer boundary violations;
- text/product collisions;
- estimated headline overflow;
- missing or visually empty output;
- repeated pack composition signatures.

Failed designs are repaired and rerendered up to `MAX_AUTOMATIC_REPAIRS` times. Provider-backed visual review is an optional second layer, not a requirement for rendering.

## Tests

```powershell
npm test
```

The tests use local rendering and mocked provider responses. They do not call live APIs.

## Current boundary

Implemented now:

- multimodal draft accumulation;
- clarification state;
- optional local Whisper adapter;
- optional uploaded-image vision classification;
- one best-design specification for the current publisher prototype;
- Adobe-independent PNG rendering;
- private binary asset storage;
- deterministic repair and optional rendered-image vision review.
- immutable feedback revisions and rejection regeneration;
- private multipart preview handoff;
- approval locking and five final export formats;
- idempotent private publishing handoff;
- optional native Adobe edit and rendition round-trip.

The remaining legacy infrastructure boundary is persistence for older image drafts, revisions and queues: much of that metadata still lives in process memory while binary assets live under `apps/api/data`. Gemini web-video jobs are separately durable in PostgreSQL and their MP4s live in configured S3-compatible object storage. Replace the older `job-store.js`, `drafts.js`, `adobe-queue.js` and `media-store.js` implementations with durable adapters when the shared schema is available; their API contracts and rendering workflow do not need to change.
