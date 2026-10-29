# VisionCraft / Autonomous Product Design Agent — Project Handoff

Last updated: 29 October 2026

Workspace: `D:\E Drive\Project\Agentic`

## Instructions for the next Codex chat

Continue this project from the current workspace. Read this document and `README.md`, then inspect the relevant source files before making changes. Preserve the existing implementation and do not rebuild completed milestones from scratch. Do not use live, quota-limited APIs during tests unless the user explicitly requests a real provider run. Do not put secrets in source control or chat messages.

The immediate integration priority is the WhatsApp approval/revision loop described under **Remaining work**. The design engine and approval-triggered publishing behavior already exist.

## Product goal

Build an autonomous product-design service for merchants. A merchant can provide a product brief through WhatsApp using text, images, audio, or combinations of these. The agent should understand the product, ask clarification questions when necessary, create one strong product creative, inspect and revise it using visual QA, and return the preview to WhatsApp.

The merchant can approve the design or request changes. Approval is the single trigger that creates platform-specific exports and sends them to the configured Facebook, Instagram, and Shopify publishing services. Adobe Express is optional: merchants or operators may open a design there for manual editing, but Adobe must not be required for autonomous generation.

Current prototype policy:

- Create one best design, not six.
- The backend renderer is authoritative and works without Adobe.
- Approval automatically starts publishing handoffs.
- There is no separate merchant-facing **Publish to Facebook** action.
- The temporary demo is only a testing/viewing interface. Do not keep expanding it into the production workflow.

## Current architecture

```text
WhatsApp merchant input
        |
        v
Multimodal product draft
        |
        +--> clarification questions when ambiguous
        |
        v
Autonomous design specification
        |
        v
Local SVG/Sharp renderer
        |
        v
Deterministic QA + optional Gemini vision QA
        |
        v
One preview sent to WhatsApp
        |
        +--> Edit/reject -> revision -> QA -> new preview
        |
        +--> Approve -> final exports -> publishing handoffs
                                      |-> Facebook adapter
                                      |-> shared publishing receiver

Optional path:
Design job -> Adobe Express add-on -> editable native elements -> saved revision
```

## Completed work

### 1. Multimodal product-draft intake

Implemented draft collection for structured metadata, text, uploaded product images, reference images, and audio files.

Relevant files:

- `apps/api/src/drafts.js`
- `apps/api/src/brief.js`
- `apps/api/src/transcription.js`
- `apps/api/src/media-store.js`
- `apps/api/src/server.js`

Important endpoints:

```http
POST /api/product-drafts/messages
GET  /api/product-drafts/:id
POST /api/product-drafts/:id/clarifications
POST /api/product-drafts/:id/submit
POST /api/product-drafts/:id/design
```

The service can pause ambiguous input and return clarification questions rather than guessing.

### 2. Autonomous design-specification engine

Implemented deterministic planning with optional Gemini art direction. The system creates one strongest design when `DESIGN_COUNT=1`.

Relevant files:

- `apps/api/src/planner.js`
- `apps/api/src/orchestrator.js`
- `apps/api/src/providers.js`

`DESIGN_COUNT` supports values from 1 to 6, but the current prototype should remain:

```env
DESIGN_COUNT=1
```

This controls the number of design concepts, not the number of final platform sizes.

### 3. Autonomous backend renderer

Implemented local rendering using SVG composition and Sharp. It works without Adobe and produces private binary assets.

Relevant files:

- `apps/api/src/renderer.js`
- `apps/api/src/media-store.js`

Assets can be inspected through:

```http
GET /api/assets/:id
GET /api/assets/:id/content
```

### 4. Visual QA and automatic repair

Implemented deterministic checks for layout boundaries, typography, overlaps, and other quality constraints. Optional Gemini vision critique and automatic revision are available but disabled by default to preserve free quota.

Relevant files:

- `apps/api/src/quality.js`
- `apps/api/src/providers.js`
- `apps/api/src/revisions.js`

Configuration:

```env
AUTONOMOUS_VISION_QA=false
AUTONOMOUS_MEDIA_ANALYSIS=false
AUTONOMOUS_REVISION_AI=false
MAX_AUTOMATIC_REPAIRS=3
```

### 5. Revision, rejection, and approval lifecycle

Implemented immutable revisions, selected-design editing, rejection feedback, idempotency keys, and approved-revision locking.

Endpoint:

```http
POST /api/jobs/:jobId/feedback
```

Supported actions:

- `APPROVE_ALL`
- `APPROVE_SELECTED`
- `EDIT_SELECTED`
- `REJECT_SELECTED`
- `REJECT_ALL`
- `EDIT_MANUALLY`

Direct approval is also supported:

```http
POST /api/jobs/:jobId/approve
```

Approval now defaults to delivery. It performs:

```text
Lock approved revision
-> create final exports
-> invoke every configured publishing handoff
-> record delivery results on the job
```

Handoff status can be `DELIVERED`, `PARTIAL`, `FAILED`, or `NOT_CONFIGURED`. Delivery adapters are failure-isolated, so one failing service does not prevent another configured service from receiving its files.

The following endpoint remains only for idempotent retry/recovery:

```http
POST /api/jobs/:jobId/deliver-final
```

Relevant files:

- `apps/api/src/approvals.js`
- `apps/api/src/revisions.js`
- `apps/api/src/handoff.js`
- `apps/api/src/job-store.js`
- `apps/api/src/server.js`

### 6. Final platform exports

One approved design produces five PNG exports:

| Platform key | Size |
|---|---:|
| `master` | 2160 × 2160 |
| `shopify` | 1600 × 1600 |
| `instagram_square` | 1080 × 1080 |
| `instagram_portrait` | 1080 × 1350 |
| `facebook_feed` | 1200 × 630 |

Relevant file:

- `apps/api/src/exports.js`

### 7. Facebook teammate integration

Analyzed repository:

- `https://github.com/webwizardaj/storebot-facebook.git`
- Inspected commit at the time of integration: `d12c522`

The teammate's existing publisher:

- exposes `POST /api/publish`;
- authenticates with `Authorization: Bearer PUBLISH_SECRET`;
- ignores the request body;
- selects the newest untagged image from its Cloudinary account;
- generates a caption;
- publishes through the Facebook Graph API;
- tags the Cloudinary asset as published.

Our integration does not require changing that repository. On merchant approval, our service:

1. selects the `facebook_feed` 1200 × 630 export;
2. uploads its binary bytes to the Facebook service's dedicated Cloudinary account;
3. calls the teammate's existing `/api/publish` endpoint;
4. records the returned Facebook post/photo identifiers.

The upload and publish trigger are sequential because the teammate's service chooses the newest untagged Cloudinary image. A dedicated Facebook Cloudinary account and one-design prototype reduce race risk.

Relevant implementation:

- `apps/api/src/handoff.js`
- `apps/api/src/config.js`

Required configuration:

```env
FACEBOOK_CLOUDINARY_CLOUD_NAME=
FACEBOOK_CLOUDINARY_API_KEY=
FACEBOOK_CLOUDINARY_API_SECRET=
FACEBOOK_PUBLISH_URL=https://<actual-vercel-project>/api/publish
FACEBOOK_PUBLISH_SECRET=
```

Meanings:

- Cloud name, API key, and API secret belong to the dedicated Cloudinary account used by the Facebook publisher.
- `FACEBOOK_PUBLISH_URL` is the teammate's deployed `/api/publish` URL.
- `FACEBOOK_PUBLISH_SECRET` must exactly match the teammate deployment's `PUBLISH_SECRET`.
- Facebook page ID, Facebook access token, caption-model key, and other Facebook-service secrets remain only in the teammate's deployment.

Never commit these values.

### 8. Shared publishing handoff

`PUBLISHING_HANDOFF_URL` can receive the complete final export set as multipart binary data. Metadata identifies each file's design ID, platform, dimensions, MIME type, and multipart field name.

Configuration:

```env
PUBLISHING_HANDOFF_URL=
INTERNAL_SERVICE_TOKEN=
```

This is intended for the Instagram/Shopify publishing gateway or a shared teammate receiver. Those integrations are not yet finalized.

### 9. WhatsApp preview handoff foundation

Our API can send preview assets as multipart binary files through:

```env
WHATSAPP_HANDOFF_URL=
INTERNAL_SERVICE_TOKEN=
```

Relevant implementation:

- `apps/api/src/handoff.js`
- `POST /api/jobs/:jobId/deliver-preview`

The teammate service now exposes `/whatsapp/integrations/agentic/previews`, which accepts this native `metadata` plus `preview_1` contract.

### 10. Adobe Express add-on

Implemented an Adobe Express add-on that can claim an optional edit job, recreate the selected design as editable Adobe elements, and save the edited rendition as a new immutable revision.

Relevant directory:

- `apps/design-agent-adobe`

Commands:

```powershell
npm run build:addon
npm run start:addon
```

The add-on is optional. Autonomous rendering and publishing do not require an operator to open Adobe Express.

### 11. Temporary demo interface

The API serves a temporary local interface for testing the design engine and viewing generated images.

Command:

```powershell
npm run demo
```

Default URL:

```text
http://localhost:8787
```

The separate **Publish to Facebook** action was removed. Approval itself now invokes configured handoffs. Do not continue turning this temporary page into the production application unless the user explicitly changes scope.

## WhatsApp teammate repository analysis

Analyzed repository:

- `https://github.com/Codechefskj/whatsapp_bot`
- Latest inspected commit: `d516fbb473bd0662c13738992221dbef9feb5136`
- Commit date: 28 October 2026
- The repository installed and built successfully during read-only analysis.

### What it currently supports

- Meta webhook verification and inbound webhook handling.
- Incoming plain-text messages.
- Incoming product images and captions, including authorized Meta media download.
- Interactive `Approved` and `Not approved` button replies.
- Duplicate inbound-message protection using unique WhatsApp message IDs.
- PostgreSQL persistence using Prisma.
- Uploading PNG/JPEG image bytes to WhatsApp.
- Sending one preview with approval/rejection buttons.
- Storing `externalRef`, which can hold our design job ID.
- Storing typed rejection feedback.
- Persistent per-phone draft and clarification state.
- Durable database-backed integration jobs with bounded retry and restart recovery.
- Agentic approval/edit callbacks and automatic revised-preview delivery.
- Meta webhook HMAC signature verification.
- Dedicated internal Bearer authentication; the legacy endpoint uses the same dedicated secret as `x-api-key`.

Useful existing endpoint:

```http
POST /whatsapp/designs/send
x-api-key: <current internal key>
Content-Type: multipart/form-data
```

Expected fields:

```text
to=<merchant WhatsApp number>
image=<PNG or JPEG binary>
externalRef=<our design job ID>
caption=<preview message>
```

### What it does not yet support

- Incoming audio/voice notes.
- Incoming documents.
- A production deployment smoke test with the teammate's real PostgreSQL and Meta credentials.
- Full automated Meta webhook coverage in the bot repository; the Agentic side has mocked integration coverage.

Its current `AI_API_URL` integration sends `{ "message": "..." }` and expects `level_1_simple_answer`. That contract is not compatible with our product-draft API and should not simply be pointed at our service.

## Required WhatsApp integration contract

### Merchant input to our service

The WhatsApp service must download inbound Meta media and forward text plus binary files to our product-draft endpoints. A conversation/product session must associate multiple WhatsApp messages with one draft.

Examples that must work:

- text only;
- image with caption;
- image followed by text;
- audio with text;
- image plus audio;
- multiple supporting/reference photos;
- clarification answer after the agent asks a question.

### Our preview to WhatsApp

For the simplest integration, our service should adapt its preview handoff to the teammate's existing `/whatsapp/designs/send` contract:

```text
to=<merchant number>
externalRef=<design job ID>
caption=<product/revision description>
image=<one preview PNG>
```

The compatible receiver is implemented at `/whatsapp/integrations/agentic/previews`; the legacy `/whatsapp/designs/send` route remains available for other callers.

### WhatsApp approval callback

When the merchant clicks **Approved**, the WhatsApp service must look up the design's `externalRef` and call:

```http
POST /api/jobs/:externalRef/feedback
Content-Type: application/json

{
  "action": "APPROVE_ALL",
  "messageId": "<WhatsApp message ID>"
}
```

That approval automatically creates the final files and invokes publishing handoffs. No additional publish button or endpoint call is part of the normal merchant flow.

### WhatsApp edit callback

When the merchant clicks **Not approved**, the teammate service may continue asking for a typed explanation. After receiving it, call:

```http
POST /api/jobs/:externalRef/feedback
Content-Type: application/json

{
  "action": "EDIT_SELECTED",
  "feedback": "<merchant-requested change>",
  "messageId": "<WhatsApp message ID>"
}
```

Our service creates a new revision, reruns QA, and returns a new preview. The WhatsApp service then creates a new approval row/message while preserving the previous rejected record.

## WhatsApp image integration implementation (29 October 2026)

The teammate repository is now present at `apps/whatsapp-bot` and the image workflow contract is implemented locally:

- signed Meta webhooks for inbound text and product images;
- PostgreSQL-backed asynchronous integration jobs with retry and restart recovery;
- per-phone draft/clarification sessions;
- authorized Meta image download;
- dedicated Bearer-authenticated Agentic message and feedback routes;
- native Agentic multipart preview receiver;
- idempotent preview rows and Agentic callbacks;
- approval and typed edit feedback callbacks;
- persistent Agentic product drafts and integration response keys in SQLite;
- mocked/offline integration coverage in the Agentic test suite.

Deployment still requires teammate-controlled PostgreSQL/Meta credentials, the same new `INTERNAL_SERVICE_TOKEN` in both deployments, database migration, and public service URLs. Audio/document WhatsApp intake remains intentionally out of scope until the image flow is verified.

## Remaining work, in priority order

### Priority 1 — Deploy and verify the WhatsApp image integration

1. Decide the deployed Agentic and WhatsApp base URLs.
2. Generate one dedicated high-entropy `INTERNAL_SERVICE_TOKEN` and configure the same value in both services.
3. Configure the teammate's PostgreSQL URL and run `npx prisma migrate deploy` in `apps/whatsapp-bot`.
4. Configure `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN`, and `META_APP_SECRET` in the WhatsApp deployment.
5. Point Agentic `WHATSAPP_HANDOFF_URL` to `/whatsapp/integrations/agentic/previews` on the deployed bot.
6. Run one private image + caption -> clarification/edit -> approval smoke test. Do not enable live Facebook/Instagram/Shopify publishing during this integration test.
7. Add audio/document intake only after the image loop is verified.

### Priority 2 — Obtain and verify Facebook deployment values

The Facebook teammate must securely provide:

1. dedicated Cloudinary cloud name;
2. Cloudinary API key;
3. Cloudinary API secret;
4. deployed Vercel `/api/publish` URL;
5. the value matching their `PUBLISH_SECRET`.

Place these only in the local/deployment `.env`, restart the API, and verify `/health` reports the Facebook publisher configured. A real publish test should happen only after the user explicitly authorizes creating a live Facebook post.

### Priority 3 — Finalize Instagram and Shopify receivers

The respective teammates need to provide either:

- one shared `PUBLISHING_HANDOFF_URL` that routes platform-tagged binary parts; or
- separate authenticated endpoints, in which case add dedicated adapters similar to the Facebook adapter.

For each receiver, document:

- endpoint URL;
- authentication header/secret;
- accepted MIME type and maximum size;
- expected multipart field names;
- metadata contract;
- idempotency behavior;
- synchronous versus queued response;
- success/failure response schema.

### Priority 4 — Persistent production storage and job queue

Current job/media storage is prototype-oriented. Before production:

- move job state to PostgreSQL or another durable database;
- move binary media to private object storage;
- add a durable queue/outbox for rendering and cross-service delivery;
- add retry state and dead-letter handling;
- preserve idempotency across process restarts;
- add retention/cleanup rules.

### Priority 5 — End-to-end integration verification

After teammate endpoints and credentials are available, verify this sequence:

```text
Merchant sends product text + media on WhatsApp
-> draft is assembled
-> agent asks clarification if needed
-> one preview is created
-> WhatsApp displays preview with buttons
-> merchant requests an edit
-> revised preview arrives
-> merchant approves
-> Facebook adapter receives 1200 × 630 export
-> Instagram/Shopify handoffs receive their exports
-> each delivery result is recorded
```

Use mocked endpoints first. Perform real publishing only with explicit authorization.

### Priority 6 — Hardening

- Validate Meta's webhook signature.
- Rotate the dedicated internal integration token independently from `META_VERIFY_TOKEN`.
- Upgrade vulnerable dependencies in the WhatsApp repository.
- Add input size/type limits for all inbound media.
- Add timeouts and bounded retries.
- Avoid logging access tokens, phone numbers, raw media, or secrets.
- Add structured logs and correlation IDs based on job ID/revision ID.
- Add monitoring for failed and partial handoffs.

## Environment reference

Start by copying `.env.example` to `.env`, then fill only the required provider/integration values.

```env
PORT=8787
DEMO_MODE=true
DESIGN_COUNT=1

SERPAPI_KEY=
TAVILY_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash-lite
PIXABAY_API_KEY=
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_IMAGE_MODEL=@cf/black-forest-labs/flux-1-schnell

AUTONOMOUS_VISION_QA=false
AUTONOMOUS_MEDIA_ANALYSIS=false
AUTONOMOUS_REVISION_AI=false
MAX_AUTOMATIC_REPAIRS=3

LOCAL_WHISPER_ENABLED=false
LOCAL_WHISPER_MODEL=small
PYTHON_COMMAND=python

WHATSAPP_HANDOFF_URL=
PUBLISHING_HANDOFF_URL=
INTERNAL_SERVICE_TOKEN=

FACEBOOK_CLOUDINARY_CLOUD_NAME=
FACEBOOK_CLOUDINARY_API_KEY=
FACEBOOK_CLOUDINARY_API_SECRET=
FACEBOOK_PUBLISH_URL=
FACEBOOK_PUBLISH_SECRET=
```

Notes:

- `DEMO_MODE=true` avoids quota-limited external providers and uses local placeholders/fallbacks.
- For a real provider run, set `DEMO_MODE=false` and configure the desired providers.
- Free-tier model/API availability changes over time; verify current official provider documentation before relying on a specific model.
- Do not expose server secrets in browser or Adobe add-on code.

## Commands

Install dependencies:

```powershell
npm run install:all
```

Run temporary local interface and API:

```powershell
npm run demo
```

Run API in development mode:

```powershell
npm run dev:api
```

Run tests and build the Adobe add-on:

```powershell
npm test
```

Start Adobe add-on development server:

```powershell
npm run start:addon
```

## Verification status

At the last completed verification:

- 14 API tests passed.
- Adobe Express add-on build passed.
- Syntax checks passed for the approval, handoff, server, and demo client files.
- Tests explicitly disabled live provider and publishing configuration, so no limited API quota or real Facebook publishing was consumed.
- The WhatsApp teammate repository installed and built successfully during read-only analysis; it was not modified.

Relevant automated test file:

- `apps/api/test/workflow.test.js`

It includes a mocked test proving that automatic approval uploads the single Facebook export to Cloudinary before triggering the teammate's unchanged publisher.

## Known limitations and decisions

- The workspace root was not a Git repository during the last inspection, so no project commit/branch was created here.
- Current job/media persistence is not yet production durable.
- The Facebook teammate's newest-untagged-image approach can race if multiple jobs share the same Cloudinary account. The one-design prototype and dedicated account reduce but do not eliminate this risk.
- Agentic uses the bot's native `/whatsapp/integrations/agentic/previews` adapter; `/whatsapp/designs/send` remains a separate legacy contract.
- Adobe Express does not provide the autonomous backend renderer; it is an optional editing surface.
- Product-image discovery and generative backgrounds depend on external API availability and quotas. Deterministic fallbacks exist.
- The system intentionally generates one concept for the current prototype, while producing multiple size variants from that concept.

## Files to inspect first in the next chat

1. `PROJECT_HANDOFF.md`
2. `README.md`
3. `.env.example`
4. `apps/api/src/server.js`
5. `apps/api/src/drafts.js`
6. `apps/api/src/orchestrator.js`
7. `apps/api/src/approvals.js`
8. `apps/api/src/handoff.js`
9. `apps/api/src/revisions.js`
10. `apps/api/test/workflow.test.js`

## Suggested next-chat opening request

```text
Read PROJECT_HANDOFF.md and inspect the current code before changing anything. Continue the project from the existing implementation. First complete the WhatsApp integration contract using the teammate repository analysis in the handoff: binary preview delivery, approval callback, edit-feedback callback, multimodal inbound messages, and clarification routing. Preserve approval-triggered publishing, keep DESIGN_COUNT=1, do not expand the temporary demo, and run only mocked/offline tests unless I explicitly authorize a live provider or publishing action.
```

## Autonomous video-post implementation (2026-10-29)

The app now includes a second autonomous creative path for 8–60 second vertical product films, defaulting to 30 seconds for practical local rendering:

- persistent `VIDEO_POST` jobs and media metadata in SQLite;
- one serialized local GPU/media queue with cancellation, retry, and restart recovery;
- deterministic or Qwen3/Ollama one-treatment planning with exact duration normalization;
- diverse generated people/story source frames plus product-identity-safe hero keyframes;
- FramePack motion generation, Practical-RIFE interpolation, and Real-ESRGAN upscale adapters;
- original ACE-Step 120 BPM music with beat-grid editing and optional Kokoro narration;
- ffprobe QA for duration, dimensions, frame rate, and a required audio stream;
- immutable natural-language revisions, approval locking, and master/Reel/square/portrait/poster exports;
- binary preview/final handoffs and video-specific events;
- playable review, progress polling, revisions, approval, and downloads in the local studio UI;
- `GET /api/video-worker/health` for local runtime/model readiness.

The CUDA runtime lives at `D:\AI-Models\runtimes\framepack-py311` with PyTorch 2.6.0+cu124. CUDA allocation was verified on the RTX 4050 Laptop GPU. FramePack weights, Practical-RIFE 4.25-lite weights, Real-ESRGAN, ACE-Step weights, Kokoro weights, FFmpeg, and ffprobe are detected. The worker is process-isolated so a model/GPU failure cannot corrupt the API queue.

Verification completed:

- 19 API tests pass and the Adobe add-on builds;
- a real 8-second MP4 passed motion/audio/duration QA and every export;
- a real 60.000-second MP4 passed at 24 fps with audio, then produced five MP4 variants and a poster;
- the running API reports video enabled, worker mode `worker`, and a healthy inventory.

The local runtime proofs are under `artifacts/`: FramePack generated 37 real frames, RIFE produced 60 fps motion, Real-ESRGAN produced 540×960 frames, ACE-Step produced an exact 10-second stereo score, and Kokoro produced narration. The configured D: pagefile now provides 57.2 GB total commit capacity, clearing FramePack's prior Windows error 1455. Merchant-ready output still requires the merchant's actual raster product image and brief; the UI blocks video submission when no product file was uploaded.
