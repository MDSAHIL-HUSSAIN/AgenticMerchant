# Agentic Merchant — Current Work Handoff

Last updated: 30 October 2026 (Asia/Calcutta)

Workspace: `D:\E Drive\Project\Agentic`

Repository: `MDSAHIL-HUSSAIN/AgenticMerchant`

Branch / last committed revision: `main` / `29433f4`

## Read this first in a new chat

This file is the authoritative snapshot of the work completed so far. The older `PROJECT_HANDOFF.md` contains useful design history, while `WHATSAPP_IMAGE_INTEGRATION_HANDOFF.md` contains additional WhatsApp contract details. Some status text in the older handoff predates the deployed WhatsApp integration and the switch from FramePack to LTX-Video.

When resuming:

1. Read this file, `PROJECT_HANDOFF.md`, `WHATSAPP_IMAGE_INTEGRATION_HANDOFF.md`, and `README.md`.
2. Inspect `git status` and preserve all existing uncommitted work.
3. Do not regenerate or redownload models that are already installed.
4. Do not expose or commit secrets. Use the existing local/deployment environment variables.
5. Do not start a long video render unless the user explicitly requests it. The latest LTX integration is verified with a short benchmark, but a new complete advertisement has not yet been rendered with it.

## Product goal

Build an autonomous merchant-content system that can receive product details and media, create an image or video advertisement, inspect and revise its own work, send previews to WhatsApp, accept approval or feedback, and publish approved variants to social platforms.

The current prototype creates one strongest image concept (`DESIGN_COUNT=1`) and platform-specific exports. The video path is product-centric, uses a story/director layer, generates real motion for selected shots, adds synchronized original music and sound design, performs QA, and creates platform variants.

## Current architecture

```text
WhatsApp product image + caption
        |
        v
Deployed WhatsApp bot (Meta webhook + durable integration worker)
        |
        v
Deployed Agentic image API
        |
        +--> autonomous image design -> QA -> WhatsApp preview
        |                                  |
        |                                  +--> edit feedback -> revision
        |                                  +--> approval -> platform exports
        |
        +--> local video pipeline
             Qwen3/Ollama director
             -> story and shot plan
             -> LTX 0.9.6 distilled I2V (primary)
             -> FramePack (fallback)
             -> motion/product QA
             -> RIFE/Real-ESRGAN when useful
             -> ACE-Step music + sound design
             -> FFmpeg composition and exports
```

## Deployment state

### Agentic image API

- Public base URL: `https://agentic-image-api.onrender.com`
- Render Blueprint service: `agentic-image-api`
- Blueprint file: `render.yaml`
- Health endpoint: `GET /health`
- Render runs the image path only. `VIDEO_POST_ENABLED=false` is intentional because local GPU models cannot run on the Render free web service.
- Render uses ephemeral `/tmp/agentic-data`; production durability still requires persistent storage/database work.

### WhatsApp bot

- Public base URL: `https://whatsapp-bot-1lmp.onrender.com`
- Repository: `https://github.com/Codechefskj/whatsapp_bot`
- Agentic preview receiver: `POST /whatsapp/integrations/agentic/previews`
- The bot deployment successfully reported:
  - `Config loaded`
  - `WhatsApp routes loaded`
  - `Durable Agentic integration worker started`
  - `Server running on port 10000`
- Its Prisma migration was deployed after an initial missing `IntegrationJob` table error.
- A real WhatsApp image test reached the durable worker. Meta media download then returned OAuth error 190 because the teammate's Meta access token was invalid/expired. This is a teammate credential issue, not an Agentic API contract failure.

### Internal authentication

- Agentic and the WhatsApp bot must use the same high-entropy `INTERNAL_SERVICE_TOKEN`.
- Never reuse `META_VERIFY_TOKEN` for service authentication.
- Never copy the token into source, documentation, screenshots, or chat responses.

### Facebook

- Teammate service base previously supplied: `https://storebot-facebook.onrender.com`
- The actual publish value must include its publish route, normally `https://storebot-facebook.onrender.com/api/publish` after confirming that route with the teammate.
- Current Agentic adapter uploads the Facebook export to the teammate's dedicated Cloudinary account, then calls the teammate's publish endpoint because that service selects the newest untagged Cloudinary image.
- Required deployment variables are `FACEBOOK_CLOUDINARY_CLOUD_NAME`, `FACEBOOK_CLOUDINARY_API_KEY`, `FACEBOOK_CLOUDINARY_API_SECRET`, `FACEBOOK_PUBLISH_URL`, and `FACEBOOK_PUBLISH_SECRET`.
- Do not perform a real Facebook post unless the user explicitly authorizes it.

### Instagram

- Teammate API supplied: `https://jiit-hackathon.onrender.com/api/post`
- Repository supplied: `https://github.com/ananya015btmae24-hub/JIIT-hackathon`
- Agentic configuration keys exist: `INSTAGRAM_PUBLISH_URL` and `INSTAGRAM_PUBLISH_API_KEY`.
- The immediate scope is image publishing. Confirm the teammate's final request schema, authentication header, success response, and idempotency behavior before relying on a production publish.
- Do not perform a real Instagram post unless the user explicitly authorizes it.

## Image workflow completed

- Multimodal product drafts with text, images, references, audio/transcription hooks, and clarification questions.
- Deterministic planning plus optional provider-assisted art direction.
- Local SVG/Sharp rendering independent of Adobe Express.
- Deterministic visual QA, optional vision QA, and automatic repairs.
- Immutable revisions, rejection/edit feedback, approval locking, and idempotency keys.
- Approval-triggered export and delivery flow.
- Five image exports:

| Export | Dimensions |
|---|---:|
| master | 2160 × 2160 |
| Shopify | 1600 × 1600 |
| Instagram square | 1080 × 1080 |
| Instagram portrait | 1080 × 1350 |
| Facebook feed | 1200 × 630 |

- Optional Adobe Express add-on for manual editing; it is not required for autonomous rendering.
- Temporary local demo UI for testing only.

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

## WhatsApp image integration completed

The teammate bot and Agentic now have the foundation for:

- signed Meta webhook ingestion;
- incoming WhatsApp product images and captions;
- authorized Meta media download;
- durable database-backed asynchronous jobs with retry/restart recovery;
- message-ID deduplication;
- per-phone draft and clarification state;
- Agentic multipart preview delivery;
- Approve / Not Approved buttons;
- approval callbacks to Agentic;
- typed revision feedback callbacks to Agentic;
- dedicated internal Bearer authentication.

Expected flow:

```text
Merchant sends image/caption to WhatsApp
-> bot queues inbound message by WhatsApp message ID
-> bot downloads Meta media
-> bot calls Agentic draft/message API
-> Agentic generates and QA-checks one preview
-> Agentic sends preview to bot's integration endpoint
-> bot sends preview and buttons to merchant
-> approve calls Agentic feedback endpoint
-> rejection text calls Agentic edit feedback endpoint
```

The most recent real test stopped at Meta media authentication error 190. The teammate must refresh/configure a valid `META_ACCESS_TOKEN` for the WhatsApp Business phone/app, then retry the inbound image.

## Video pipeline: current implementation

### Editable self-revising editor added

The video pipeline now preserves the existing Qwen director, LTX motion generation, FFmpeg audio/encoding and recovery behavior while adding an editable Remotion picture-edit layer:

- timeline schema v2 records reusable composition, camera curve, typography, transition and inspection instructions for every shot;
- the Python worker returns accepted per-shot sources plus candidate-selection evidence;
- Remotion assembles preview and approved full-resolution compositions from those accepted sources;
- Qwen3-VL reviews representative entrance, midpoint, exit and transition frames;
- deterministic inspection catches blank frames and nearly static shots if the vision model is unavailable;
- visual findings map to bounded targeted repairs, and unaffected keyframes and LTX clips are reused;
- each job saves editable timelines, motion selections, visual-review reports, repair history and a production manifest;
- category-aware deterministic music direction now covers technology, fashion/luxury and food when the Qwen music supervisor is unavailable;
- Remotion and Qwen failures are recorded and fall back to the existing FFmpeg edit or deterministic review rather than losing a completed render.

New files include `apps/api/src/video-timeline.js`, `apps/api/src/remotion-client.js`, `apps/api/src/video-visual-review.js`, and `apps/remotion-video-editor/`.

The implementation has not started a new long render. The next complete product render will exercise the new preview → inspect → targeted repair → approval/final-render path.

The original FramePack-first video path was technically valid but too slow and creatively weak. The pipeline has since gained a director/editor layer, product-centric story planning, shot candidate QA, better music selection, sound design, and an LTX primary motion provider.

### Creative behavior

- Product-centric story; no requirement to invent human characters.
- Qwen3 through local Ollama can create a structured treatment and shot plan.
- The plan carries shot purpose, composition, camera motion, lighting, continuity, cut intention, typography, sound cues, and music direction.
- The compositor supports generative shots, product-safe motion graphics/hybrid shots, overlays, deliberate variable shot lengths, transitions, typography, sound design, and platform exports.
- Shot generation is treated as raw material: motion candidates are measured for product identity, motion, sharpness, and brightness drift before acceptance.
- ACE-Step creates original music candidates, and selection accounts for the planned edit/cut timing.
- QA verifies duration, resolution, frame rate, audio presence, story coverage, motion evidence, and other structural requirements.

### Motion provider change completed

Primary motion provider is now:

```env
VIDEO_MOTION_PROVIDER=ltx
VIDEO_MOTION_FALLBACK=framepack
```

LTX configuration:

```env
LTX_COMFY_URL=http://127.0.0.1:8190
LTX_COMFY_PORT=8190
LTX_WIDTH=448
LTX_HEIGHT=768
LTX_FRAMES=49
LTX_FPS=16
LTX_STEPS=8
```

The LTX runner uses ComfyUI's API without requiring the desktop UI. It can start the compatible server automatically, submit the workflow, wait for frames, and encode an MP4. If LTX fails its generation or product-motion QA and fallback remains enabled, the worker unloads LTX and tries FramePack.

### Installed local video components

#### LTX / ComfyUI

- Official model: `D:\AI-Models\ltxv-2b-0.9.6-distilled-04-25.safetensors`
- Model hard link used by ComfyUI: `D:\Comfy-Desktop\ComfyUI-Shared\models\checkpoints\ltxv-2b-0.9.6-distilled-04-25.safetensors`
- T5 FP8 encoder: `D:\Comfy-Desktop\ComfyUI-Shared\models\text_encoders\t5xxl_fp8_e4m3fn_scaled.safetensors`
- Compatible ComfyUI source: `D:\AI-Models\ComfyUI-LTX096`
- Compatible ComfyUI tag: `v0.3.30`, commit `a97f2f8`
- CUDA 12.4 Python runtime: `D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv-cu124\Scripts\python.exe`
- Model path configuration: `D:\Comfy-Desktop\instance-model-paths-cu124.yaml`
- Shared input: `D:\Comfy-Desktop\ComfyUI-Shared\input`
- Shared output: `D:\Comfy-Desktop\ComfyUI-Shared\output`
- API server: `http://127.0.0.1:8190`
- Logs:
  - `D:\Comfy-Desktop\logs\comfy-ltx096.stdout.log`
  - `D:\Comfy-Desktop\logs\comfy-ltx096.stderr.log`

Do not use the default Comfy Desktop Python runtime for this pipeline. It contained PyTorch `2.12.1+cu130`, which was incompatible with the installed NVIDIA 551.76 driver. The separate CUDA 12.4 environment is the verified runtime.

#### Other local models/tools

- FramePack runtime: `D:\AI-Models\runtimes\framepack-py311`
- FramePack remains a fallback, not the primary generator.
- Practical-RIFE is available for selective interpolation.
- Real-ESRGAN is available for selective enhancement/upscaling.
- ACE-Step is available for original music generation.
- Kokoro is available for optional narration, although the current product advertisement is intended to work without spoken narration.
- FFmpeg and ffprobe are installed and detected.
- GPU: NVIDIA RTX 4050 Laptop GPU, 6 GB VRAM.

### LTX benchmark completed

Verified profile:

| Setting | Value |
|---|---:|
| Resolution | 448 × 768 portrait |
| Frames | 49 |
| FPS | 16 |
| Duration | 3.0625 seconds |
| Steps | 8 |
| First-run runner elapsed | 59.49 seconds |
| Comfy execution | 56.41 seconds |
| Sampling portion | about 5 seconds |

Benchmark output:

`D:\E Drive\Project\Agentic\apps\api\data\video-work\ltx-benchmark-448x768-49f.mp4`

Benchmark frame samples:

- `apps/api/data/video-work/ltx-benchmark-frames/start.png`
- `apps/api/data/video-work/ltx-benchmark-frames/middle.png`
- `apps/api/data/video-work/ltx-benchmark-frames/end.png`

The benchmark showed stable product/model identity and real subtle movement. Comfy models were unloaded afterward, leaving the GPU idle. A new full advertisement was deliberately not started after this integration step.

### New/changed video code

- `apps/video-worker/ltx_comfy_runner.py` — headless LTX ComfyUI runner and MP4 encoder.
- `apps/video-worker/worker.py` — LTX health, dispatch, caching, QA, fallback, memory unloading, improved candidate selection.
- `apps/api/src/config.js` — LTX paths/profile and motion-provider configuration.
- `apps/api/src/video-worker-client.js` — passes LTX configuration to the worker.
- `apps/api/src/video-compositor.js` — includes motion provider, fallback, and LTX profile in compose specifications.
- `apps/api/src/video-planner.js` — richer creative/story planning.
- `apps/api/src/video-orchestrator.js` — autonomous video lifecycle.
- `apps/api/src/video-quality.js` — creative and structural QA.
- `apps/api/src/video-renderer.js` — keyframe/shot preparation.
- `apps/video-worker/ace_music.py` — music candidate and edit-sync improvements.

### Latest completed video job before LTX switch

Job: `4e27ea64-b719-4288-a57d-9e71f142e062`

- Status: `READY_FOR_PUBLISHING`
- QA score: 100
- It used recovered FramePack clips because it began before the LTX provider change.
- Shot 5 candidate 1 passed motion QA with score 82.25 and identity 0.92156.
- Final assets:
  - master: `asset_79d90c28-1c38-4301-83cc-d51d11b4f049`
  - Instagram: `asset_e1b94587-3107-47b1-9853-67912c96fcf5`
  - Facebook: `asset_69e33d3b-2106-4460-8784-30f2b946a982`
  - square: `asset_ee029d31-7352-40e1-b7dc-d0602e67f0b8`
  - portrait: `asset_a1ccda69-fcb2-4f97-b4c5-c5ec8605c309`
  - poster: `asset_32ec642c-5598-4a69-b7e1-51ff2faebdda`

The old FramePack scorer bug was fixed: sample timestamps now use the measured encoded duration so QA does not seek beyond EOF and incorrectly reject a valid clip.

## Verification completed

- All API tests passed: 21/21.
- Node syntax checks passed for the changed video configuration/client/compositor files.
- Python compilation passed for `worker.py` and `ltx_comfy_runner.py`.
- Worker health detected:
  - LTX ready;
  - FramePack fallback ready;
  - RIFE ready;
  - Real-ESRGAN ready;
  - ACE-Step ready;
  - Kokoro ready;
  - CUDA 12.4 on the RTX 4050.
- LTX benchmark MP4 completed successfully.
- `git diff --check` reported line-ending warnings only, not patch errors.

## Git state — important

The LTX and recent cinematic-video work is not yet committed. At the time of this handoff, the expected working tree includes:

```text
 M .env.example
 M README.md
 M apps/api/src/config.js
 M apps/api/src/video-compositor.js
 M apps/api/src/video-orchestrator.js
 M apps/api/src/video-planner.js
 M apps/api/src/video-quality.js
 M apps/api/src/video-renderer.js
 M apps/api/src/video-worker-client.js
 M apps/api/test/video-workflow.test.js
 M apps/video-worker/README.md
 M apps/video-worker/ace_music.py
 M apps/video-worker/worker.py
?? apps/video-worker/ltx_comfy_runner.py
?? CURRENT_WORK_HANDOFF.md
```

Do not reset or discard these changes. Re-run `git status` because the user may have staged or committed files after this document was written.

The repeated `LF will be replaced by CRLF` messages from Git on Windows are warnings, not failures.

## Commands for the next chat

From `D:\E Drive\Project\Agentic`:

```powershell
git status
npm test
```

Check video worker readiness without starting a render:

```powershell
& "D:\AI-Models\runtimes\framepack-py311\Scripts\python.exe" "apps\video-worker\worker.py" health
```

Run the API locally when needed:

```powershell
npm run demo
```

Inspect a video job/state using the existing utility:

```powershell
node tools/inspect-video-state.mjs
```

## Recommended next step

### Guaranteed product-video fallback

The worker now guarantees a product-matched motion source for every generative shot. LTX still runs first and FramePack can still serve as the configured model fallback. If both fail, `worker.py` creates a deterministic camera and lighting clip from the shot's designed product keyframe and records an accepted `product-template` motion selection for QA and the editable timeline. RIFE and Real-ESRGAN are also nonfatal, and fallback music now follows the planned BPM and key. This avoids substituting unrelated downloaded stock footage while ensuring a real product image can still produce a complete video.

The active default is now `VIDEO_FAST_TEMPLATE_MODE=true`. New jobs skip all model generation and use a 15-second, six-shot product template with reusable camera/light clips, FFmpeg editing, deterministic inspection and synthesized category-directed music. The product's own rendered keyframes remain the source, so the fast output still matches the submitted item. Set the flag to `false` only when a slower LTX/FramePack/Remotion production is explicitly wanted.

When the user is ready, run one short product-centric 15-second advertisement through the new LTX-first pipeline. Use the merchant's actual product image and brief, review the structured story/shot plan, then let the autonomous pipeline generate, score, compose, mix, QA, and export it. Compare the result with the previous FramePack version before attempting a 30- or 60-second advertisement.

Separately, the next WhatsApp live-test action is for the teammate to replace the invalid/expired Meta access token and resend one product image with a caption.

## Suggested prompt for a new chat

```text
Read CURRENT_WORK_HANDOFF.md, PROJECT_HANDOFF.md, WHATSAPP_IMAGE_INTEGRATION_HANDOFF.md, and README.md in D:\E Drive\Project\Agentic. Inspect git status and preserve all uncommitted work. Continue from the existing LTX-first autonomous video pipeline; do not rebuild or redownload installed models. First verify worker health and the current tests. Do not start a long render or publish to a real social account unless I explicitly ask.
```
