# Agentic Merchant — Current Work Handoff

Last updated: 31 October 2026 (Asia/Calcutta)

This is the authoritative context for the next chat. Read this file before changing code. Older handoff documents contain historical video/WhatsApp details but may describe states that have since changed.

## Current objective and scope

The latest completed work adds a standalone **voice dashboard** as a second client of the Agentic image workflow. It behaves like the WhatsApp workflow—product brief, clarification, image preview, revisions, approval and publishing—but keeps its conversations and previews separate from WhatsApp.

Current scope is **image generation and image publishing only**. Do not reintroduce Instagram video work or modify the local LTX/FramePack video pipeline unless the user explicitly asks.

## Repositories

### 1. Agentic API

- Local path: `D:\E Drive\Project\Agentic`
- GitHub: `https://github.com/MDSAHIL-HUSSAIN/AgenticMerchant`
- Branch: `main`
- Current commit: `e9a02d1 add voice dashboard integration`
- The working tree was clean before this handoff document was updated.
- Deployed API: `https://agentic-image-api.onrender.com`

### 2. Voice dashboard

- Local path: `D:\E Drive\Project\dashboard`
- GitHub: `https://github.com/Codechefskj/dashboard`
- Current repository commit before this work: `bdb4593 Initial commit: Voice Studio dashboard`
- The new dashboard work is **not committed or pushed yet**.
- Expected dashboard working tree:

```text
 M .env.example
 M README.md
 M package-lock.json
 M package.json
 M public/index.html
 M server.js
?? render.yaml
?? test/
```

The two folders are independent Git repositories. Commit and push them separately.

## Work completed in Agentic

The Agentic voice-dashboard integration is committed in `e9a02d1`.

Changed files:

```text
.env.example
README.md
apps/api/src/config.js
apps/api/src/drafts.js
apps/api/src/handoff.js
apps/api/src/job-store.js
apps/api/src/server.js
apps/api/src/whatsapp-integration.js
apps/api/test/workflow.test.js
render.yaml
```

Implemented behavior:

- Added `POST /api/integrations/dashboard/messages`.
- Added `POST /api/integrations/dashboard/jobs/:id/feedback`.
- Preserved the existing WhatsApp endpoints.
- Added `sourceChannel` and `targetChannels` to drafts/jobs.
- Dashboard conversations use the `dashboard:` namespace; WhatsApp continues using `whatsapp:`.
- Message and feedback idempotency are scoped by source channel.
- Cross-channel feedback is rejected; WhatsApp cannot approve a dashboard job and vice versa.
- Dashboard previews go only to `DASHBOARD_HANDOFF_URL`.
- WhatsApp previews continue going only to `WHATSAPP_HANDOFF_URL`.
- Final approved media is not sent back to WhatsApp or the dashboard as another preview.
- Publishing only invokes explicitly selected image channels (`instagram` and/or `facebook`).
- An empty target-channel list exports the approved assets without social publishing.
- Existing WhatsApp image behavior remains intact.

Important design rule: the shared integration implementation still lives in `apps/api/src/whatsapp-integration.js`; it now exposes both WhatsApp and dashboard wrappers. The filename is historical and does not mean dashboard traffic is routed through WhatsApp.

## Work completed in the dashboard repository

The dashboard now acts as a voice-first Agentic client.

Backend behavior:

- Calls only the dashboard-specific Agentic endpoints, never WhatsApp endpoints.
- Sends `sourceChannel: dashboard` and `conversationId: dashboard:<merchantId>`.
- Accepts Agentic image previews at `POST /integrations/agentic/previews`.
- Validates the internal Bearer token and merchant ID on preview callbacks.
- Uses structured `targetChannels` for Instagram/Facebook.
- Supports clarification, revision, approval and publish-result responses.
- Spoken approval requires confirmation before publishing.
- Supports optional PostgreSQL persistence for state and binary media.
- Uses a local filesystem fallback if `DATABASE_URL` is absent.
- Marks interrupted in-flight work failed after restart so it can be resent safely.
- Emits structured logs for persistence, messages, transcripts, previews and job completion/failure.

Frontend behavior:

- Browser speech recognition captures English (`en-IN`) or Hindi (`hi-IN`).
- Spoken messages and manual sends after transcription use the voice-command route.
- Browser speech synthesis reads Agentic replies aloud.
- Clarifications, preview-ready messages, revision results, approval status and publishing results are spoken.
- Includes mute/unmute and replay controls.
- Stops microphone capture before speaking to reduce audio feedback.
- Shows only supported image publishing choices: Instagram and Facebook.
- No video controls or video publishing were added.

## Validation already completed

Agentic:

- `node --test test/workflow.test.js`: **9/9 passed** (run from `apps/api`).
- Relevant JavaScript syntax checks passed.
- `git diff --check` had only Windows LF/CRLF warnings.
- A prior full `npm test` result was **20/21 passed**; the only failure was an unrelated video QA assertion in `video-workflow.test.js`. The targeted image/dashboard tests passed.

Dashboard:

- `npm test`: **1/1 passed**.
- Test confirms dashboard message endpoint usage, preview callback behavior, approval confirmation and dashboard feedback usage.
- Test confirms no WhatsApp endpoint is called by the dashboard.
- Browser script syntax check passed.
- Local server health check passed.
- `npm audit`: **0 vulnerabilities**.

## Render deployment

### Dashboard Blueprint

The dashboard repository contains `render.yaml`. After its changes are committed and pushed, the teammate should:

1. Open Render and choose **New → Blueprint**.
2. Connect/select `Codechefskj/dashboard`.
3. Render will detect the root `render.yaml`.
4. Supply the three secret/manual values when prompted:

```env
AGENTIC_API_URL=https://agentic-image-api.onrender.com
INTERNAL_SERVICE_TOKEN=<exactly the same value used by Agentic>
DASHBOARD_TOKEN=<a new strong dashboard password>
```

The Blueprint automatically:

- creates the `agentic-voice-dashboard` web service;
- creates the free `agentic-voice-dashboard-db` PostgreSQL database;
- wires `DATABASE_URL` from that database;
- sets `DATABASE_SSL=true`;
- sets `DASHBOARD_MERCHANT_ID=dashboard`;
- uses `npm ci`, `npm start` and `/health`.

Do not put real secret values in `.env.example`, `render.yaml`, Git, screenshots or handoff documents.

### Agentic callback configuration

After the dashboard is live, copy its Render URL and set this variable on the **Agentic** Render service:

```env
DASHBOARD_HANDOFF_URL=https://<dashboard-service>.onrender.com/integrations/agentic/previews
```

Then redeploy Agentic. Keep the existing WhatsApp callback unchanged:

```env
WHATSAPP_HANDOFF_URL=https://whatsapp-bot-1lmp.onrender.com/whatsapp/integrations/agentic/previews
```

Both Agentic and the dashboard must have the identical `INTERNAL_SERVICE_TOKEN`.

The Agentic Render service intentionally keeps `VIDEO_POST_ENABLED=false`.

## Full project history and completed systems

The sections below preserve the work that predates the voice dashboard. Some features—especially local video generation—remain in the repository but are not enabled on the deployed Render image service.

### Original product goal

Build an autonomous merchant-content system that can receive product details and media, create image and video advertisements, evaluate and revise its own output, ask the merchant for clarification, deliver previews, receive natural-language changes or approval, and publish platform-specific assets.

The prototype deliberately generates one strongest image concept (`DESIGN_COUNT=1`) and derives several platform exports from it. Adobe Express is optional as a manual editing surface; the autonomous renderer does not depend on it.

### Autonomous image pipeline

Completed capabilities:

- Multimodal product drafts from text and product images, with reference/audio transcription hooks.
- Clarification questions when required product information is missing.
- Deterministic planning with optional provider-assisted visual direction.
- SVG/Sharp-based local composition and rendering.
- Deterministic visual QA, optional vision QA and bounded automatic repair.
- Immutable revisions from natural-language feedback.
- Approval locking and idempotent integration responses.
- Detailed structured activity logs for generation, media, QA, handoff and publishing success/failure.
- Placeholder fallback when no product image is supplied.
- Generated image previews can serve as product media for downstream workflows when a supplied product photo is unavailable.

Image exports:

| Export | Dimensions |
|---|---:|
| Master | 2160 × 2160 |
| Shopify | 1600 × 1600 |
| Instagram square | 1080 × 1080 |
| Instagram portrait | 1080 × 1350 |
| Facebook feed | 1200 × 630 |

Important image files:

- `apps/api/src/drafts.js`
- `apps/api/src/orchestrator.js`
- `apps/api/src/planner.js`
- `apps/api/src/renderer.js`
- `apps/api/src/quality.js`
- `apps/api/src/revisions.js`
- `apps/api/src/approvals.js`
- `apps/api/src/handoff.js`
- `apps/api/src/exports.js`
- `apps/api/src/whatsapp-integration.js`

### WhatsApp image integration

Deployed services:

- Agentic API: `https://agentic-image-api.onrender.com`
- WhatsApp service: `https://whatsapp-bot-1lmp.onrender.com`
- WhatsApp repository: `https://github.com/Codechefskj/whatsapp_bot`
- Preview receiver: `POST /whatsapp/integrations/agentic/previews`

Completed WhatsApp contract:

- Signed Meta webhook ingestion in the teammate service.
- Incoming product image and caption handling.
- Authorized Meta media download.
- PostgreSQL-backed durable asynchronous jobs with retry/restart recovery.
- WhatsApp message-ID deduplication.
- Per-phone draft and clarification state.
- Authenticated multipart calls to Agentic.
- Multipart image preview delivery back to the bot.
- Approve / Not Approved buttons.
- Approval and typed edit-feedback callbacks.
- Dedicated shared Bearer authentication using `INTERNAL_SERVICE_TOKEN`.
- Detailed logs on both sides.

Flow:

```text
WhatsApp image + caption
-> Meta webhook
-> durable WhatsApp integration job
-> Agentic /api/integrations/whatsapp/messages
-> clarification OR image render + QA
-> WhatsApp preview callback
-> preview and controls shown to merchant
-> edit feedback creates a new immutable revision
-> approval exports and publishes configured image variants
```

WhatsApp configuration rules:

- Agentic and the bot must use the same high-entropy `INTERNAL_SERVICE_TOKEN`.
- Never reuse `META_VERIFY_TOKEN` as the internal token.
- The teammate service needs `DATABASE_URL`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_VERIFY_TOKEN` and `META_APP_SECRET`.
- Its Render start command must apply Prisma migrations before starting.
- Keep `WHATSAPP_HANDOFF_URL` unchanged when configuring the dashboard.

Historical integration problems and fixes:

- A missing `IntegrationJob` database table was fixed by deploying the Prisma migration.
- Meta OAuth error 190 indicated an invalid/expired teammate Meta token, not an Agentic rendering failure.
- Repeated `Product draft not found` errors occurred after rolling deployments/commits left stale clarification IDs in the external worker while Agentic used ephemeral/replaced state. The integration was hardened to recover instead of repeatedly treating stale draft references as valid.
- A request that logged `continuingDraft: true` but then appeared idle was part of the same stale conversation/draft-state issue.
- The user force-reset `main` to `9ec3b37` (`logs added`) during diagnosis, then added the WhatsApp error recovery commit `20592cb` and later the dashboard commit `e9a02d1`.
- Final approved media is intentionally not sent to WhatsApp again; WhatsApp receives previews during review, then publishing status rather than a duplicate final preview.

For the full original API payload contract and teammate file map, also read `WHATSAPP_IMAGE_INTEGRATION_HANDOFF.md`.

### Social image publishing

Image publishing adapters and logs were added for Instagram and Facebook. Real posts must never be triggered without explicit authorization.

Facebook history:

- Teammate service base: `https://storebot-facebook.onrender.com`.
- Confirm the actual route before use; the previously expected route was commonly `/api/publish`.
- Agentic uploads the Facebook export to the teammate's dedicated Cloudinary account and calls the publisher.
- Expected variables: `FACEBOOK_CLOUDINARY_CLOUD_NAME`, `FACEBOOK_CLOUDINARY_API_KEY`, `FACEBOOK_CLOUDINARY_API_SECRET`, `FACEBOOK_PUBLISH_URL`, `FACEBOOK_PUBLISH_SECRET`.
- A historical failure said `Failed to parse URL from FACEBOOK_PUBLISH_URL=https://...`; this means the environment value was entered with the variable name included. Render must contain only the URL as the value.

Instagram history:

- Teammate endpoint supplied earlier: `https://jiit-hackathon.onrender.com/api/post`.
- Repository supplied earlier: `https://github.com/ananya015btmae24-hub/JIIT-hackathon`.
- Expected Agentic variables: `INSTAGRAM_PUBLISH_URL` and `INSTAGRAM_PUBLISH_API_KEY`.
- A historical Instagram request returned an HTML Render `502`, indicating the teammate service/upstream endpoint failed; it was not an image-render failure.
- A later attempt to add companion/video posting through Instagram was explicitly abandoned and undone. The current work is image-only.

Publishing semantics:

- Image and video cannot be assumed to appear as one cross-platform carousel; each platform API and teammate endpoint must explicitly support a multi-item/carousel contract.
- The current dashboard selects Instagram and/or Facebook image targets.
- WhatsApp is a review/conversation channel, not a public social-publishing target.
- A historical WhatsApp `400` response—`Only image design previews are accepted by this endpoint`—came from incorrectly sending final/video media to the preview endpoint. The current code keeps preview handoff and publishing separate.

### Local autonomous video pipeline (historical but still relevant)

The project progressed from a FramePack-first generator to an LTX-first creative pipeline and then gained a fast product-template mode for reliable demos. This subsystem is local because the GPU models cannot run on the free Render web service.

Creative/editor architecture:

```text
product image + brief
-> Qwen3/Ollama treatment and shot plan
-> designed product keyframes
-> LTX 0.9.6 distilled image-to-video (primary slow mode)
-> FramePack (model fallback)
-> deterministic product-template motion (guaranteed fallback / fast mode)
-> motion and product-identity QA
-> optional RIFE interpolation and Real-ESRGAN enhancement
-> Remotion/FFmpeg picture edit, transitions and typography
-> ACE-Step category-aware music and sound design
-> Qwen3-VL/deterministic visual review
-> targeted repair, platform exports and poster
```

Direction and edit improvements completed:

- Product-category-aware story, direction, editing and music.
- Product-centric direction without requiring invented human characters.
- Qwen can choose duration, number of shots, shot purposes, composition, motion, lighting, continuity, cut intentions, typography and sound cues.
- Variable shot lengths and more than 15-second stories are supported by the creative path.
- Product background removal/compositing and placement on designed environments are supported by the planning/rendering approach.
- Candidate clips are scored for identity, motion, sharpness and brightness drift before acceptance.
- Timeline schema v2 records composition, camera curve, typography, transitions and inspection instructions.
- Remotion assembles editable previews/finals from accepted sources.
- Qwen3-VL can inspect entrance/midpoint/exit/transition frames; deterministic review catches blank or static shots if Qwen is unavailable.
- Repairs are bounded and reuse unaffected keyframes/clips.
- Every job preserves timelines, selections, visual review, repair history and a production manifest.
- Qwen/Remotion/RIFE/Real-ESRGAN failures are nonfatal when safe deterministic fallbacks exist.

#### FramePack phase

- FramePack initially produced more realistic human frames but was too slow for the desired autonomous advertisement workflow.
- It remains available as a fallback at `D:\AI-Models\runtimes\framepack-py311`.
- A scorer bug was fixed by sampling against measured encoded duration instead of seeking beyond EOF and rejecting valid clips.
- Windows error 1455 was addressed by increasing pagefile/commit capacity; the system reported about 57.2 GB total commit capacity afterward.

#### LTX phase

Primary slow-mode provider:

```env
VIDEO_MOTION_PROVIDER=ltx
VIDEO_MOTION_FALLBACK=framepack
LTX_COMFY_URL=http://127.0.0.1:8190
LTX_COMFY_PORT=8190
LTX_WIDTH=448
LTX_HEIGHT=768
LTX_FRAMES=49
LTX_FPS=16
LTX_STEPS=8
```

The headless runner can start the compatible ComfyUI API, submit the workflow, collect frames, encode MP4 and unload the model. LTX is best used for controlled product/environment motion, not demanding photorealistic humans on this small distilled model and 6 GB GPU.

Installed LTX components:

- Model: `D:\AI-Models\ltxv-2b-0.9.6-distilled-04-25.safetensors`
- Comfy hard link: `D:\Comfy-Desktop\ComfyUI-Shared\models\checkpoints\ltxv-2b-0.9.6-distilled-04-25.safetensors`
- T5 FP8: `D:\Comfy-Desktop\ComfyUI-Shared\models\text_encoders\t5xxl_fp8_e4m3fn_scaled.safetensors`
- Compatible source: `D:\AI-Models\ComfyUI-LTX096`
- Compatible tag/commit: `v0.3.30` / `a97f2f8`
- CUDA 12.4 Python: `D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv-cu124\Scripts\python.exe`
- Model paths: `D:\Comfy-Desktop\instance-model-paths-cu124.yaml`
- Shared input/output: `D:\Comfy-Desktop\ComfyUI-Shared\input` and `D:\Comfy-Desktop\ComfyUI-Shared\output`
- Logs: `D:\Comfy-Desktop\logs\comfy-ltx096.stdout.log` and `comfy-ltx096.stderr.log`

Do not use the default Comfy Desktop Python runtime for this workflow. Its PyTorch/CUDA combination was incompatible with the installed NVIDIA 551.76 driver. The separate CUDA 12.4 runtime was verified.

Verified LTX benchmark:

| Setting | Result |
|---|---:|
| Resolution | 448 × 768 |
| Frames | 49 |
| FPS | 16 |
| Duration | 3.0625 seconds |
| Steps | 8 |
| First-run elapsed | 59.49 seconds |
| Comfy execution | 56.41 seconds |
| Sampling portion | about 5 seconds |

Benchmark output: `apps/api/data/video-work/ltx-benchmark-448x768-49f.mp4`.

#### Fast deterministic product-video mode

The later reliability requirement was: generate a product-matched video quickly from any product photo without waiting for model generation or downloading unrelated stock footage.

The active default became:

```env
VIDEO_FAST_TEMPLATE_MODE=true
```

Behavior:

- Uses a 15-second, six-shot product template.
- Reuses the submitted/generated product keyframes.
- Applies deterministic camera and lighting motion rather than unrelated universal stock clips.
- Uses FFmpeg editing, deterministic inspection and synthesized category-directed music.
- If slow mode is enabled and both LTX and FramePack fail, the same product-template path supplies a valid accepted clip.
- Set the flag to `false` only when a slower LTX/FramePack/Remotion generation is explicitly requested.

This was chosen because the user prioritized a fast, dependable, product-relevant video over uncertain long GPU generation. Video delivery/publishing experiments were later removed from the active WhatsApp/Instagram deployment scope.

#### Other local video tools

- Practical-RIFE for selective interpolation.
- Real-ESRGAN for selective enhancement/upscaling.
- ACE-Step for original/category-directed music.
- Kokoro for optional narration.
- FFmpeg and ffprobe for composition, encoding and QA.
- Qwen3/Ollama for story/direction and Qwen3-VL for visual review when configured.
- GPU: NVIDIA RTX 4050 Laptop GPU, 6 GB VRAM.

Important video code:

- `apps/video-worker/ltx_comfy_runner.py`
- `apps/video-worker/worker.py`
- `apps/video-worker/ace_music.py`
- `apps/api/src/video-planner.js`
- `apps/api/src/video-renderer.js`
- `apps/api/src/video-compositor.js`
- `apps/api/src/video-orchestrator.js`
- `apps/api/src/video-quality.js`
- `apps/api/src/video-worker-client.js`
- `apps/api/src/video-timeline.js`
- `apps/api/src/remotion-client.js`
- `apps/api/src/video-visual-review.js`
- `apps/remotion-video-editor/`

Latest historically recorded completed video job before the LTX switch:

- Job: `4e27ea64-b719-4288-a57d-9e71f142e062`
- Status: `READY_FOR_PUBLISHING`
- QA score: 100
- Used recovered FramePack clips because it started before the provider switch.
- Master asset: `asset_79d90c28-1c38-4301-83cc-d51d11b4f049`
- Instagram: `asset_e1b94587-3107-47b1-9853-67912c96fcf5`
- Facebook: `asset_69e33d3b-2106-4460-8784-30f2b946a982`
- Square: `asset_ee029d31-7352-40e1-b7dc-d0602e67f0b8`
- Portrait: `asset_a1ccda69-fcb2-4f97-b4c5-c5ec8605c309`
- Poster: `asset_32ec642c-5598-4a69-b7e1-51ff2faebdda`

Historical runtime proofs also included a real 8-second MP4, a 60-second 24 fps MP4 with audio and exports, FramePack frames, RIFE 60 fps motion, 540×960 Real-ESRGAN frames, an exact 10-second ACE-Step stereo score and Kokoro narration.

### Deployment and persistence limitations

- Render runs the image path only; `VIDEO_POST_ENABLED=false` is intentional.
- Agentic currently uses `/tmp/agentic-data` and SQLite on Render, so its state/media are ephemeral across replacement deployments.
- The dashboard adds its own PostgreSQL persistence, but that does not make Agentic's internal SQLite durable.
- Production Agentic should eventually move drafts/jobs to PostgreSQL, media to private object storage, and outbound work to a durable queue/outbox.
- Free Render services may sleep and cause a cold-start delay.
- Never log tokens, phone numbers, raw private media or credentials.

### Historical Git/deployment notes

- Windows messages such as `LF will be replaced by CRLF` are warnings, not commit failures.
- `git push origin mai` failed only because the branch name was mistyped; the correct branch is `main`.
- A forced rollback was performed with `git reset --hard 9ec3b37` and `git push --force-with-lease`. Do not repeat destructive Git operations unless the user explicitly requests them.
- Current Agentic history relevant to the latest state:
  - `9ec3b37 logs added`
  - `20592cb whstapp eerrro fix`
  - `e9a02d1 add voice dashboard integration`
- Always run `git status` separately in Agentic and dashboard before editing; they are independent repositories.

## What remains to do

1. In `D:\E Drive\Project\dashboard`, review `git status`, then commit and push the dashboard changes to its GitHub repository.
2. Have the teammate create/update the dashboard service using its `render.yaml` Blueprint.
3. Obtain the deployed dashboard URL.
4. Set `DASHBOARD_HANDOFF_URL` on Agentic Render and redeploy Agentic.
5. Run an end-to-end test:
   - sign in to the dashboard;
   - speak or type a product brief;
   - answer any clarification;
   - receive an image preview in the dashboard only;
   - request a spoken revision;
   - approve and confirm publishing;
   - verify selected platform publishing and spoken result.
6. Confirm that the dashboard preview does not appear in WhatsApp and that WhatsApp behavior remains unchanged.

Do not perform a real Instagram/Facebook post without explicit user authorization and valid teammate publisher endpoints.

## Useful commands for the next chat

Agentic:

```powershell
Set-Location 'D:\E Drive\Project\Agentic'
git status
git log -3 --oneline
Set-Location 'D:\E Drive\Project\Agentic\apps\api'
node --test test/workflow.test.js
```

Dashboard:

```powershell
Set-Location 'D:\E Drive\Project\dashboard'
git status
npm test
```

## Suggested prompt for the next chat

```text
Read D:\E Drive\Project\Agentic\CURRENT_WORK_HANDOFF.md completely. Inspect git status in both D:\E Drive\Project\Agentic and D:\E Drive\Project\dashboard and preserve existing work. Continue the image-only voice-dashboard deployment from the documented state. Do not add video work, do not route dashboard previews through WhatsApp, and do not publish to a real social account unless I explicitly authorize it.
```
