# VisionCraft Autonomous Video Post Plan

Last updated: 29 October 2026

Workspace: `D:\E Drive\Project\Agentic`

This plan extends the existing autonomous image-post service with one autonomous, agentic video-post workflow. It preserves the completed image pipeline, the WhatsApp-first product contract, immutable revisions, approval-triggered publishing, optional Adobe editing for images, and offline/mock testing defaults.

## 1. Product decision

Video is a second job type in the existing service:

```text
IMAGE_POST | VIDEO_POST
```

The merchant supplies the same multimodal product brief through WhatsApp and may request a video explicitly or be routed to video by structured metadata. The service creates one strongest video treatment, not several concepts. It asks clarification questions only when a missing answer blocks a credible result.

The normal merchant experience remains:

```text
Send product text/media
-> agent plans, generates, evaluates and repairs autonomously
-> receive one video preview in WhatsApp
-> request an edit or approve
-> approval locks the revision, creates final exports and invokes publishing handoffs
```

There is no mandatory storyboard-approval step and no separate publish button. Storyboards and shot diagnostics are internal artifacts that make the agent controllable and debuggable.

## 2. What “frame-first” means

The system must not prompt an image model independently for every output frame. Independent generation would cause product drift, logo corruption, flicker and inconsistent lighting.

The professional frame-first approach is:

1. create controlled start, hero and optional end keyframes for each shot;
2. generate a temporally coherent frame sequence from those anchors;
3. extract and inspect the actual frames;
4. repair or regenerate only failed shots;
5. interpolate, stabilize and upscale approved sequences;
6. composite product pixels, logos, typography and legal copy deterministically;
7. assemble one authored timeline with deterministic audio mixing.

FramePack provides coherent motion frames. RIFE creates intermediate frames. Real-ESRGAN performs upscaling. FFmpeg performs image-sequence assembly, timing, compositing, audio mixing and encoding. Generated models never draw the final logo, product name, price, CTA or legal text.

## 3. Autonomous agent loop

Video generation is controlled by one orchestrator with specialized planning and evaluation modules. These are logical agent roles, not separate uncontrolled services.

```text
OBSERVE
  Read brief, product assets, brand assets, references and requested channel.

PLAN
  Choose one creative treatment, shot structure, timing, keyframes, motion,
  copy, music direction and optional narration.

ACT
  Render keyframes, generate motion frames, interpolate, upscale, compose and mix.

EVALUATE
  Run product, temporal, composition, typography, audio and delivery QA.

REPAIR
  Apply bounded shot-level repair or switch to a deterministic fallback.

DELIVER
  Send one preview to WhatsApp.

LEARN WITHIN THE JOB
  Convert merchant feedback into an immutable targeted revision while retaining
  the approved brief, seeds, assets, shot history and QA evidence.
```

### Logical agent responsibilities

| Role | Responsibility | Primary tools |
|---|---|---|
| Brief agent | Normalize product facts and decide whether clarification is required | Existing draft/brief modules, local Qwen3 |
| Creative director | Select one campaign idea, visual language and emotional arc | Local Qwen3 plus deterministic fallback |
| Shot planner | Produce a duration-valid shot manifest and transition graph | Local Qwen3 plus schema validation |
| Asset curator | Select merchant assets and prevent reference images from replacing the product identity | Existing media classifications and scoring |
| Motion director | Choose deterministic, parallax or generative motion per shot | FramePack and compositor profiles |
| Audio director | Choose music structure, optional narration and sound cues | ACE-Step, Kokoro and deterministic SFX |
| QA critic | Score visual continuity, product preservation, frame health, text, audio and platform compliance | Deterministic analyzers first |
| Repair controller | Regenerate, simplify or fall back at shot level within fixed budgets | Orchestrator policy |

### Autonomy policy

- The agent chooses one best treatment automatically.
- It does not expose multiple concepts merely to avoid making a decision.
- It may ask the merchant a question only when product identity, intended post type, required brand asset, or a material claim is ambiguous.
- It performs at most a configured number of repairs per shot and per job.
- It never loops indefinitely.
- When generative motion repeatedly fails, it falls back to a deterministic premium motion treatment rather than failing the entire video.
- It records why a tool, fallback or repair was selected.
- Optional cloud providers remain opt-in. The complete default path is local.

## 4. Target video structure

The planner may adapt timing to the product, but a default 60-second treatment is:

| Time | Purpose |
|---|---|
| 0–5 s | Material, light or silhouette hook |
| 5–12 s | Controlled product reveal |
| 12–20 s | Hero presentation |
| 20–29 s | Feature or material detail |
| 29–38 s | Precision/craft sequence |
| 38–47 s | Context, use or movement |
| 47–56 s | Emotional hero shot |
| 56–60 s | Product name, logo and CTA lockup |

This is an authored sequence of shots, but every shot is managed as a frame sequence rather than an opaque clip. A shot can be deterministic, hybrid or generative:

- `DETERMINISTIC`: product cutout, camera transforms, light sweeps, particles, depth/parallax and typography;
- `HYBRID`: real product layer over a generated moving environment;
- `GENERATIVE`: FramePack motion anchored to an approved product/reference keyframe.

The motion director should prefer deterministic or hybrid rendering for hero and lockup shots, where exact product and logo fidelity matter most.

## 5. Architecture

```text
WhatsApp service
    |
    v
Existing multimodal draft and clarification layer
    |
    v
Content router: IMAGE_POST or VIDEO_POST
    |                         |
    |                         v
    |                 Video orchestrator
    |                         |
    |              persistent job + GPU queue
    |                         |
    |                 local Python worker
    |        +----------------+----------------+
    |        |                |                |
    |     FramePack       RIFE/ESRGAN     ACE-Step/Kokoro
    |        +----------------+----------------+
    |                         |
    |                  FFmpeg compositor
    |                         |
    v                         v
Existing image preview      MP4 preview
    |                         |
    +-------------> WhatsApp approval/revision loop
                              |
                              v
                  approval-triggered finalization
                              |
                              v
                  platform video handoffs
```

The Node API remains the system of record and orchestrator. Python owns model inference. FFmpeg owns deterministic video/audio assembly. The browser demo remains a development viewer and is not promoted into the production merchant workflow.

## 6. Required domain model

Extend jobs without breaking current image jobs:

```js
{
  id,
  type: "VIDEO_POST",
  status,
  brief,
  creativeTreatment,
  videoSpec: {
    durationSeconds: 60,
    aspectRatio: "9:16",
    fps: 30,
    previewWidth: 540,
    previewHeight: 960,
    finalWidth: 1080,
    finalHeight: 1920,
    narrationEnabled,
    musicEnabled,
    shots: []
  },
  currentRevisionId,
  revisions,
  previewAssets,
  finalAssets,
  qa,
  handoffs,
  processedKeys,
  createdAt,
  updatedAt
}
```

Each shot stores:

```js
{
  id,
  order,
  purpose,
  durationSeconds,
  renderMode,
  productAssetIds,
  referenceAssetIds,
  startKeyframeAssetId,
  endKeyframeAssetId,
  prompt,
  negativePrompt,
  seed,
  camera,
  motion,
  copy,
  status,
  attempts,
  frameManifestAssetId,
  previewAssetId,
  qa
}
```

Every revision stores the complete creative treatment, shot manifest, seeds, model/runtime versions, preview asset, feedback and QA results. Merchant edits target the smallest affected scope: copy, audio, one shot, a range of shots or the whole treatment.

## 7. Persistent execution foundation

Video generation can run for a long time on the available RTX 4050 6 GB GPU. In-memory jobs are not sufficient.

Before video inference is connected:

1. introduce a job-store interface;
2. retain the current memory adapter for unit tests;
3. add a durable local SQLite adapter for drafts, jobs, revisions, attempts and handoffs;
4. add an atomic disk/object adapter for binary media and frame manifests;
5. create one serialized GPU queue;
6. persist progress after every shot and processing stage;
7. resume interrupted jobs after restart;
8. add bounded retries, cancellation and dead-letter state;
9. preserve idempotency keys across restarts;
10. add retention rules for raw frames and temporary intermediates.

Suggested video lifecycle:

```text
QUEUED
PLANNING
GENERATING_KEYFRAMES
GENERATING_MOTION
RUNNING_TEMPORAL_QA
GENERATING_AUDIO
COMPOSITING_PREVIEW
AWAITING_APPROVAL
REVISING
FINALIZING
EXPORTING_FINAL_ASSETS
READY_FOR_PUBLISHING
PARTIAL
FAILED
CANCELLED
```

## 8. Runtime and worker boundary

Create a local worker package:

```text
apps/video-worker/
  worker.py
  protocol.py
  framepack_runner.py
  rife_runner.py
  realesrgan_runner.py
  kokoro_runner.py
  ace_step_client.py
  ffmpeg_pipeline.py
  temporal_qa.py
  product_qa.py
  audio_qa.py
  requirements.txt
```

Add Node-side modules:

```text
apps/api/src/video-planner.js
apps/api/src/video-orchestrator.js
apps/api/src/video-worker-client.js
apps/api/src/video-quality.js
apps/api/src/video-revisions.js
apps/api/src/video-exports.js
apps/api/src/video-handoff.js
apps/api/src/task-queue.js
```

Node and Python communicate with a versioned newline-delimited JSON protocol initially. The API passes asset IDs and validated parameters, not arbitrary filesystem paths or shell strings. Child processes are spawned with argument arrays and `shell: false`.

Because VRAM is limited, the queue must never run FramePack and ACE-Step concurrently. Models are loaded only for their stage and released before the next GPU-heavy stage.

## 9. Autonomous planning and validation

The local Qwen3 planner returns a strict JSON creative treatment. A deterministic planner remains available if Ollama is unavailable or returns invalid output.

Validation rules include:

- exactly one creative treatment;
- total shot duration equals the requested duration;
- every claim is grounded in merchant-provided product facts;
- every shot has a purpose and a supported render mode;
- logo, price, CTA and legal text are deterministic overlays;
- hero and closing shots preserve exact product assets;
- seeds and tool settings are recorded;
- negative prompts explicitly exclude text, logos, duplicate products and deformed geometry;
- platform safe areas are known before rendering;
- generation cost fits the configured time/storage budget.

## 10. Frame generation and compositing

### Keyframes

Add a vertical keyframe renderer that reuses the existing palette, typography, product selection and composition concepts while supporting 9:16 layouts. Keyframes use merchant product pixels whenever possible. A background-removal/cutout tool may be added as a bounded preprocessing tool, but absence of a cutout must not block generation.

### Motion frames

FramePack generates coherent sequences for approved generative/hybrid shots. Its downloaded model paths are configured explicitly; it must not silently download a second copy. Output is always extracted to a numbered frame sequence plus a manifest.

### Interpolation and upscaling

- RIFE creates smooth in-between frames where needed.
- Real-ESRGAN upscales final approved sequences.
- Temporal deflicker and color normalization run after generative processing.
- Text, product lockups and logos are composited after generative processing.
- Intermediate frames use bounded directories owned by the job and shot IDs.

### Preview versus final

The autonomous pass produces a complete low-resolution, compressed preview with final timing, music, narration and copy. Approval locks that revision. Finalization then performs expensive upscaling/interpolation and platform encoding without changing the creative treatment.

## 11. Agentic quality and bounded repair

QA is evidence-producing and shot-specific.

### Visual and temporal checks

- missing, corrupt, black or near-empty frames;
- wrong frame count or duration;
- sudden luminance, hue or exposure jumps;
- duplicate/frozen frames;
- excessive inter-frame motion;
- product leaving its safe region;
- product count or silhouette changing unexpectedly;
- visible generative text/logo artifacts;
- transition discontinuity;
- unsafe typography or CTA placement;
- missing brand/product lockup.

### Audio checks

- missing or truncated music/voice files;
- clipping and true-peak violations;
- excessive silence;
- narration/music masking;
- target loudness;
- final audio/video duration mismatch;
- fade and cut alignment.

### Repair policy

1. retry the failed processing step with identical creative intent;
2. adjust motion strength, seed or negative prompt;
3. shorten or split only the failed shot while preserving total duration;
4. switch from generative to hybrid motion;
5. switch from hybrid to deterministic premium motion;
6. fail the job only when required product/brand input is unusable or every allowed fallback fails.

Repairs are capped by `MAX_VIDEO_SHOT_REPAIRS` and `MAX_VIDEO_JOB_REPAIRS`. Each repair records its trigger, action and resulting score.

## 12. Revision behavior

The current immutable revision lifecycle remains authoritative.

Examples:

- “Make the reveal slower” targets camera/motion timing for the reveal shot.
- “Use less dramatic music” regenerates or remixes audio without rerendering visuals.
- “Change the headline” updates deterministic overlays only.
- “Show more fabric detail” replans and rerenders the detail shot.
- “Make everything calmer” can update the treatment and all affected shots while retaining the original revision.

Unchanged shots and assets are reused. A revision must not regenerate the entire minute when a bounded change is sufficient.

## 13. API additions

Reuse the draft endpoints. Add a content type to draft submission/design creation and introduce video-specific asynchronous operations:

```http
POST /api/product-drafts/:id/video
GET  /api/video-jobs/:id
GET  /api/video-jobs/:id/events
POST /api/video-jobs/:id/feedback
POST /api/video-jobs/:id/approve
POST /api/video-jobs/:id/cancel
POST /api/video-jobs/:id/retry
```

Approval and feedback may also be normalized behind the existing `/api/jobs/:id/feedback` contract so WhatsApp does not need separate image/video callback logic. The job type determines the revision and export implementation.

Large video assets require streamed responses and HTTP Range support. The existing asset-content route must not load an entire MP4 into memory.

Progress is delivered through server-sent events with polling fallback. WhatsApp receives meaningful milestone messages only when desired; it must not receive a message for every internal frame-processing stage.

## 14. WhatsApp contract changes

Video must join the WhatsApp-first workflow rather than depend on the temporary browser demo.

### Inbound

The WhatsApp integration forwards:

- requested post type (`VIDEO_POST`);
- product text and captions;
- product/reference/logo images;
- audio/voice notes;
- desired duration or platform when supplied.

The same conversation/draft grouping and clarification state planned in `PROJECT_HANDOFF.md` apply to both job types.

### Outbound preview

The teammate service currently supports an image preview. Extend its authenticated internal contract to accept an MP4 preview and poster image, either through a compatible media field or a dedicated video route. Store our job ID in `externalRef` exactly as with images.

### Approval and edit callbacks

The existing callback shape remains valid:

```json
{
  "action": "APPROVE_ALL",
  "messageId": "<WhatsApp message ID>"
}
```

or:

```json
{
  "action": "EDIT_SELECTED",
  "feedback": "<merchant feedback>",
  "messageId": "<WhatsApp message ID>"
}
```

The design service resolves `externalRef`, discovers the job type and runs the correct revision or approval path.

## 15. Publishing implications

The existing Facebook teammate integration is image-specific and selects the newest untagged Cloudinary image. It cannot be assumed to publish video.

Video rollout therefore requires explicit contracts for:

- Facebook video/Reel upload and publish status;
- Instagram Reel container creation, processing and publication;
- Shopify product-media upload if video is desired there;
- maximum duration, dimensions, codecs, file sizes and synchronous/asynchronous status;
- idempotency and retry semantics.

Approval remains the single trigger, but video handoffs may return `PROCESSING` and require status polling. Do not emulate video publishing by uploading an MP4 to the current image-only Cloudinary flow.

## 16. Final exports

One approved master produces platform variants, not new creative concepts:

| Key | Intended output |
|---|---|
| `video_master` | High-quality vertical master |
| `instagram_reel` | 1080 × 1920 MP4 |
| `facebook_reel` | 1080 × 1920 MP4 |
| `social_square` | 1080 × 1080 derived MP4 when required |
| `social_portrait` | 1080 × 1350 derived MP4 when required |
| `poster` | Preview/thumbnail image |
| `captions` | Optional subtitle/caption sidecar |

Encoding defaults should use broadly compatible H.264/AAC MP4, with actual platform constraints confirmed when receiver contracts are finalized.

## 17. Configuration additions

Add paths and bounded policies to `.env.example`; do not hardcode machine-specific paths in source:

```env
VIDEO_POST_ENABLED=false
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_PLANNER_MODEL=qwen3:8b

VIDEO_WORKER_PYTHON=
FRAMEPACK_ROOT=
FRAMEPACK_MODEL_ROOT=
RIFE_ROOT=
REALESRGAN_ROOT=
ACESTEP_BASE_URL=http://127.0.0.1:8001
KOKORO_MODEL_ROOT=
FFMPEG_PATH=

VIDEO_PREVIEW_WIDTH=540
VIDEO_PREVIEW_HEIGHT=960
VIDEO_FINAL_WIDTH=1080
VIDEO_FINAL_HEIGHT=1920
VIDEO_DEFAULT_DURATION_SECONDS=60
VIDEO_DEFAULT_FPS=30
MAX_VIDEO_SHOT_REPAIRS=2
MAX_VIDEO_JOB_REPAIRS=8
VIDEO_TEMP_RETENTION_HOURS=24
```

Production/deployment paths belong in environment configuration. Secrets remain outside source and logs.

## 18. Delivery milestones

### Milestone V0 — Preserve and baseline

- Run the existing 14 API tests and Adobe build.
- Add job-type fields with backward-compatible defaults.
- Add regression tests proving the image pipeline is unchanged.
- Document downloaded model paths and licenses.

### Milestone V1 — Durable execution foundation

- Add store interfaces and persistent local adapter.
- Add serialized task/GPU queue, retries, cancellation and resume.
- Add structured progress events and correlation IDs.
- Extend media storage for large streamed assets and Range requests.

### Milestone V2 — Local runtime verification

- Install FFmpeg and isolated Python runtimes.
- Point every tool to the existing downloaded weights.
- Run smoke tests for FramePack, RIFE, Real-ESRGAN, ACE-Step and Kokoro.
- Verify GPU release between stages.

### Milestone V3 — Autonomous treatment and shot planner

- Add strict video schemas and deterministic fallback.
- Connect local Qwen3 through Ollama.
- Generate one duration-valid treatment and shot manifest.
- Add grounding, product-fidelity and budget validation.

### Milestone V4 — One-shot frame pipeline

- Create vertical keyframe rendering.
- Generate one coherent FramePack sequence.
- Extract frames and run temporal QA.
- Interpolate, upscale, overlay product/text and encode one shot.
- Demonstrate deterministic fallback on a forced generation failure.

### Milestone V5 — Complete autonomous preview

- Render all planned shots through the serialized queue.
- Generate music, optional narration and sound cues.
- Assemble a complete preview.
- Run bounded automatic repairs.
- Save the treatment, manifests, assets and QA evidence as revision 1.

### Milestone V6 — Agentic revision and approval

- Route natural-language feedback to the smallest affected scope.
- Reuse unchanged shots.
- Lock approved revisions.
- Finalize high-resolution platform variants after approval.
- Preserve the existing approval-triggered behavior.

### Milestone V7 — WhatsApp video loop

- Extend binary preview delivery to MP4 plus poster.
- Route clarification, edit and approval callbacks for video jobs.
- Add outbox/retry/idempotency behavior.
- Verify the full loop with mocked Meta endpoints.

### Milestone V8 — Video publishing adapters

- Finalize authenticated Facebook, Instagram and Shopify video contracts.
- Add asynchronous publish-status tracking where required.
- Isolate partial failures and support idempotent recovery.
- Perform live publishing only after explicit authorization.

### Milestone V9 — Hardening and acceptance

- Add retention/cleanup, disk-budget checks and observability.
- Add dependency and model-license review.
- Run an 8-second hardware smoke test.
- Run a complete 60-second acceptance render.
- Confirm image and video jobs can coexist without GPU or storage races.

## 19. Test strategy

Automated tests remain offline by default.

### Unit tests

- schema validation and exact duration totals;
- one-treatment policy;
- grounded product claims;
- tool routing and fallback decisions;
- repair-budget enforcement;
- revision scope selection;
- platform export mapping;
- command/path validation.

### Integration tests

- mocked Python worker protocol;
- persistent resume after API restart;
- job cancellation between shots;
- failed-shot deterministic fallback;
- unchanged-shot reuse during revision;
- video preview WhatsApp multipart contract;
- approval-triggered finalization and handoff;
- partial publisher failure isolation.

### Hardware tests

- one keyframe;
- one short motion sequence;
- one RIFE interpolation;
- one Real-ESRGAN upscale;
- one music generation;
- one voiceover;
- one 8-second composed preview;
- one full 60-second acceptance video.

Hardware tests are explicit commands and are not part of ordinary `npm test`.

## 20. Definition of done

The feature is complete when:

1. a merchant can request a video using text, images and/or audio through the shared draft flow;
2. the agent creates one grounded 60-second treatment without mandatory operator direction;
3. it selects tools per shot, generates frames, evaluates them and repairs failures autonomously;
4. product identity, logo and typography remain stable;
5. a complete preview is delivered to WhatsApp;
6. natural-language feedback creates an immutable targeted revision;
7. approval locks the revision, creates final variants and invokes configured video publishers;
8. the system survives restart and resumes unfinished work;
9. retries and fallbacks are bounded and auditable;
10. all existing image-post tests and behavior continue to pass.

## 21. Explicit non-goals for the first release

- multiple creative concepts per merchant request;
- independent AI generation of every frame;
- a full nonlinear browser video editor;
- automatic live publishing in tests;
- mandatory Adobe/Premiere integration;
- simultaneous GPU-heavy jobs on the 6 GB GPU;
- allowing generated models to render final logos, prices or legal text.

## 22. Recommended execution order relative to existing work

The existing WhatsApp image loop remains the immediate integration track from `PROJECT_HANDOFF.md`. Video planning can begin in parallel at the schema/runtime level, but the safest implementation order is:

1. finish or stabilize the shared WhatsApp conversation, clarification and callback contract;
2. implement durable jobs/media/outbox because both WhatsApp and video require it;
3. add the local video worker and one-shot smoke pipeline;
4. add autonomous treatment, QA and repair;
5. connect video preview/revision/approval to WhatsApp;
6. add platform video publishers after receiver contracts are known.

This order avoids building a second delivery system and makes image and video posts share the same production backbone.
