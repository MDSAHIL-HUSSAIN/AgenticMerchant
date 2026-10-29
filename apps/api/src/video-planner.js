import { config } from "./config.js";
import { productIdentity } from "./brief.js";

const longFormShotBlueprints = [
  { purpose: "mystery-hook", weight: 4, renderMode: "HYBRID", camera: "locked macro", motion: "edge-light reveal", focus: { x: .5, y: .58, zoom: 2.4 } },
  { purpose: "material-detail", weight: 4, renderMode: "HYBRID", camera: "macro lateral slide", motion: "grazing light across texture", focus: { x: .5, y: .68, zoom: 2.7 } },
  { purpose: "construction-detail", weight: 4, renderMode: "HYBRID", camera: "precision track", motion: "controlled detail inspection", focus: { x: .74, y: .72, zoom: 2.5 } },
  { purpose: "feature-one", weight: 5, renderMode: "HYBRID", camera: "measured push-in", motion: "feature-led depth drift", focus: { x: .48, y: .66, zoom: 1.75 } },
  { purpose: "feature-two", weight: 5, renderMode: "HYBRID", camera: "slow lateral move", motion: "secondary feature reveal", focus: { x: .32, y: .7, zoom: 1.9 } },
  { purpose: "full-form", weight: 6, renderMode: "HYBRID", camera: "slow centered dolly", motion: "complete product form emerges", focus: { x: .5, y: .62, zoom: 1.12 } },
  { purpose: "hero-reveal", weight: 7, renderMode: "HYBRID", camera: "controlled hero push", motion: "shadow recedes into clarity", focus: { x: .5, y: .62, zoom: 1.08 } },
  { purpose: "brand-lockup", weight: 4, renderMode: "DETERMINISTIC", camera: "locked", motion: "precise type and tonal resolve", focus: { x: .5, y: .62, zoom: 1.08 } }
];

// Product-first films never invent unrelated people. Every shot is derived from
// the supplied product asset and advances from detail to complete form.
const shortFormShotBlueprints = [
  { purpose: "mystery-hook", weight: 3, renderMode: "HYBRID", camera: "locked macro", motion: "warm edge light reveals one signature detail", focus: { x: .5, y: .58, zoom: 2.4 }, cutIntention: "open from black on the first tactile sound" },
  { purpose: "material-detail", weight: 4, renderMode: "HYBRID", camera: "macro lateral slide", motion: "controlled grazing light reveals texture and craft", focus: { x: .5, y: .68, zoom: 2.7 }, cutIntention: "cut as the highlight reaches the detail" },
  { purpose: "construction-detail", weight: 4, renderMode: "HYBRID", camera: "precision track", motion: "a second real detail completes the craft story", focus: { x: .74, y: .72, zoom: 2.5 }, cutIntention: "match the direction of the previous movement" },
  { purpose: "feature-impact", weight: 3, renderMode: "HYBRID", camera: "measured push-in", motion: "feature statement arrives on a restrained accent", focus: { x: .48, y: .66, zoom: 1.75 }, cutIntention: "hard cut on the strongest musical transient" },
  { purpose: "hero-reveal", weight: 6, renderMode: "HYBRID", camera: "slow centered dolly", motion: "the complete product emerges from shadow", focus: { x: .5, y: .62, zoom: 1.12 }, cutIntention: "hold through the musical lift" },
  { purpose: "brand-lockup", weight: 4, renderMode: "DETERMINISTIC", camera: "locked", motion: "minimal light resolve and precise type entrance", focus: { x: .5, y: .62, zoom: 1.08 }, cutIntention: "resolve cleanly and leave visual breathing room" }
];

const palettes = [
  ["#050505", "#F5F2EA", "#9EA7B3"],
  ["#EEEAE1", "#111113", "#A16F42"],
  ["#0B1020", "#F5F7FB", "#6EB8FF"],
  ["#171217", "#FFF8EC", "#D9B46D"]
];

const clean = (value, fallback = "") => String(value || fallback).replace(/\s+/g, " ").trim();
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));

function hash(text) {
  return [...String(text)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function exactDurations(totalSeconds, blueprints, bpm = 96) {
  const beatSeconds = 60 / bpm;
  const totalBeats = Math.max(blueprints.length, Math.round(totalSeconds / beatSeconds));
  const remaining = totalBeats - blueprints.length;
  const weightTotal = blueprints.reduce((sum, shot) => sum + shot.weight, 0);
  const quotas = blueprints.map(shot => (shot.weight / weightTotal) * remaining);
  const beats = quotas.map(quota => 1 + Math.floor(quota));
  let unassigned = totalBeats - beats.reduce((sum, value) => sum + value, 0);
  quotas.map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, unassigned)
    .forEach(({ index }) => { beats[index] += 1; });
  const durations = beats.map(value => Math.round(value * beatSeconds * 1000) / 1000);
  const priorTotal = durations.slice(0, -1).reduce((sum, value) => sum + value, 0);
  durations[durations.length - 1] = Math.round((totalSeconds - priorTotal) * 100) / 100;
  return durations;
}

export function createDeterministicVideoPlan(brief, options = {}) {
  const durationSeconds = clamp(options.durationSeconds || config.videoDefaultDurationSeconds, 8, 60);
  const shotBlueprints = durationSeconds <= 20 ? shortFormShotBlueprints : longFormShotBlueprints;
  const musicBpm = durationSeconds <= 20 ? 96 : 120;
  const durations = exactDurations(durationSeconds, shotBlueprints, musicBpm);
  const identity = productIdentity(brief);
  const palette = palettes[hash(identity) % palettes.length];
  const featureHeadlines = [
    clean(brief.features?.[0], "Designed with intention"),
    clean(brief.features?.[1], "Precision in every detail"),
    clean(brief.features?.[2], "Made for the way you move")
  ];
  const longHeadlines = [
    "Made for real moments",
    "A closer look",
    "Move your way",
    featureHeadlines[0],
    "Better, together",
    featureHeadlines[1],
    "Everyday, elevated",
    clean(brief.product, identity),
    featureHeadlines[2],
    clean(brief.callToAction, "Discover the details")
  ];
  const shortHeadlines = ["", featureHeadlines[0], featureHeadlines[1], featureHeadlines[2], clean(brief.product, identity), clean(brief.callToAction, "Discover")];
  const headlines = durationSeconds <= 20 ? shortHeadlines : longHeadlines;
  return {
    title: `${identity} — considered motion`,
    concept: `A restrained premium product film built around ${identity}, using precise light, material detail and generous negative space.`,
    tone: clean(brief.tone, "premium, minimal, confident"),
    palette,
    musicDirection: "Warm premium editorial score with tactile percussion, restrained melodic movement, spacious dynamics, a clear lift for the hero reveal and a clean final resolve; instrumental, no vocals.",
    music: {
      mood: "warm, refined, tactile and quietly confident",
      bpm: musicBpm,
      keyscale: "D minor",
      timesignature: "4/4",
      instruments: ["muted tactile percussion", "warm analog pulse", "soft felt keys", "subtle fabric-like textures"],
      avoid: ["generic corporate ukulele", "festival EDM", "busy drums", "vocals", "abrupt genre changes"],
      energyCurve: "near-silent mystery, gradual textural build, controlled lift at the full product reveal, elegant two-second resolve"
    },
    storyArc: "Mystery reveals authentic material detail, detail establishes craft, craft expands into the complete product, and the product earns a controlled hero reveal and quiet brand resolve.",
    continuity: {
      lighting: "One directional copper-motivated key light progresses from darkness to clarity.",
      product: "Preserve exact silhouette, material, color and proportions from the supplied product reference.",
      source: "Every visual must remain grounded in the supplied product asset; never invent a person, location or alternate product."
    },
    typography: { headlineFamily: "Georgia", utilityFamily: "Segoe UI", style: "editorial serif headline with restrained modern utility text" },
    narration: { enabled: Boolean(options.narrationEnabled), script: "" },
    durationSeconds,
    aspectRatio: options.aspectRatio || "9:16",
    fps: Number(options.fps || config.videoDefaultFps),
    shots: shotBlueprints.map((shot, index) => ({
      id: `shot_${String(index + 1).padStart(2, "0")}`,
      order: index + 1,
      purpose: shot.purpose,
      sceneType: "PRODUCT",
      durationSeconds: durations[index],
      renderMode: shot.renderMode,
      productAssetIds: [],
      referenceAssetIds: [],
      prompt: `${identity}. ${shot.purpose} product advertising shot. ${shot.camera}. ${shot.motion}. ${clean(brief.tone)}. Use only the supplied product reference. Preserve exact product identity, material, silhouette and color. No invented people, locations, text or alternate views.`,
      negativePrompt: "text, letters, words, logo, watermark, duplicate product, extra product, deformed geometry, changing materials, unstable lighting, jitter, flicker",
      seed: hash(`${identity}:${shot.purpose}`),
      camera: shot.camera,
      motion: shot.motion,
      focus: shot.focus,
      composition: shot.focus.zoom > 1.8 ? "A real product detail fills the upper two-thirds with disciplined negative space for one short feature line." : "The supplied product dominates the frame with clean editorial negative space.",
      lighting: index < 2 ? "Low-key grazing copper edge light." : index === shotBlueprints.length - 1 ? "Clean soft key with controlled falloff." : "Directional premium practical light with consistent warm highlights.",
      cutIntention: shot.cutIntention || "Cut on motivated action or musical punctuation.",
      soundCues: index === 0 ? ["low metallic onset", "subtle room tone"] : index === shotBlueprints.length - 1 ? ["soft tonal resolve"] : ["restrained tactile accent"],
      continuityConstraints: ["exact product identity", "consistent warm highlight direction", "no generated typography"],
      rejectionCriteria: ["product deformation", "invented subject", "unmotivated camera drift", "repeated framing", "visible generated text", "brief-to-product mismatch"],
      copy: {
        eyebrow: shot.purpose === "hero" || shot.purpose === "hero-reveal" ? clean(brief.brand, brief.category) : "",
        headline: headlines[index].slice(0, 64),
        subheadline: shot.purpose === "hero" || shot.purpose === "hero-reveal" ? clean(brief.brand, brief.category) : ""
      },
      status: "PLANNED",
      attempts: 0
    })).map((shot, index, shots) => ({
      ...shot,
      musicCue: { beat: Math.round(durations.slice(0, index).reduce((sum, value) => sum + value, 0) / (60 / musicBpm)), role: index === 0 ? "mystery onset" : index === shots.length - 2 ? "hero lift" : index === shots.length - 1 ? "final resolve" : "tactile cut" }
    }))
  };
}

export function normalizeVideoPlan(value, brief, options = {}) {
  const fallback = createDeterministicVideoPlan(brief, options);
  const source = value && typeof value === "object" ? value : {};
  const durationSeconds = clamp(options.durationSeconds || source.durationSeconds || fallback.durationSeconds, 8, 60);
  const suppliedShots = Array.isArray(source.shots) ? source.shots : [];
  const shortFilmStructureValid = durationSeconds > 20 || (
    suppliedShots.length === 6 &&
    suppliedShots.every(shot => shot.sceneType === "PRODUCT") &&
    suppliedShots.every(shot => shot.renderMode !== "GENERATIVE")
  );
  const productOnly = suppliedShots.every(shot => shot.sceneType === "PRODUCT" && shot.renderMode !== "GENERATIVE");
  const rawShots = suppliedShots.length >= 3 && suppliedShots.length <= 12 && shortFilmStructureValid && productOnly ? suppliedShots : fallback.shots;
  const normalized = rawShots.map((shot, index) => {
    const base = fallback.shots[Math.min(index, fallback.shots.length - 1)];
    return {
      ...base,
      ...shot,
      id: clean(shot.id, `shot_${String(index + 1).padStart(2, "0")}`).replace(/[^a-z0-9_-]/gi, "_").slice(0, 50),
      order: index + 1,
      purpose: clean(shot.purpose, base.purpose).slice(0, 50),
      sceneType: "PRODUCT",
      durationSeconds: clamp(shot.durationSeconds || base.durationSeconds, 1.5, durationSeconds),
      renderMode: ["DETERMINISTIC", "HYBRID"].includes(shot.renderMode) ? shot.renderMode : base.renderMode,
      prompt: clean(shot.prompt, base.prompt).slice(0, 900),
      negativePrompt: clean(shot.negativePrompt, base.negativePrompt).slice(0, 500),
      seed: Number.isInteger(Number(shot.seed)) ? Number(shot.seed) : base.seed,
      camera: clean(shot.camera, base.camera).slice(0, 100),
      motion: clean(shot.motion, base.motion).slice(0, 100),
      focus: {
        x: clamp(shot.focus?.x ?? base.focus?.x ?? .5, 0, 1),
        y: clamp(shot.focus?.y ?? base.focus?.y ?? .5, 0, 1),
        zoom: clamp(shot.focus?.zoom ?? base.focus?.zoom ?? 1, 1, 3)
      },
      copy: {
        eyebrow: clean(shot.copy?.eyebrow, base.copy.eyebrow).slice(0, 32),
        headline: clean(shot.copy?.headline, base.copy.headline).slice(0, 64),
        subheadline: clean(shot.copy?.subheadline, base.copy.subheadline).slice(0, 90)
      },
      productAssetIds: [],
      referenceAssetIds: [],
      status: "PLANNED",
      attempts: 0
    };
  });
  const sum = normalized.reduce((total, shot) => total + shot.durationSeconds, 0);
  normalized[normalized.length - 1].durationSeconds = Math.max(1.5, Math.round((normalized.at(-1).durationSeconds + durationSeconds - sum) * 10) / 10);
  const finalSum = normalized.reduce((total, shot) => total + shot.durationSeconds, 0);
  normalized[normalized.length - 1].durationSeconds = Math.round((normalized.at(-1).durationSeconds + durationSeconds - finalSum) * 10) / 10;
  const musicBpm = durationSeconds <= 20 ? 96 : 120;
  const alignedDurations = exactDurations(durationSeconds, normalized.map(shot => ({ weight: shot.durationSeconds })), musicBpm);
  const distinctFocusCount = new Set(normalized.map(shot => `${shot.focus.x.toFixed(2)}:${shot.focus.y.toFixed(2)}:${shot.focus.zoom.toFixed(2)}`)).size;
  if (distinctFocusCount < Math.min(4, normalized.length)) {
    normalized.forEach((shot, index) => { shot.focus = { ...fallback.shots[Math.min(index, fallback.shots.length - 1)].focus }; });
  }
  normalized.forEach((shot, index) => {
    shot.durationSeconds = alignedDurations[index];
    shot.musicCue = {
      beat: Math.round(alignedDurations.slice(0, index).reduce((total, value) => total + value, 0) / (60 / musicBpm)),
      role: clean(shot.musicCue?.role, index === normalized.length - 2 ? "hero lift" : index === normalized.length - 1 ? "final resolve" : "tactile cut")
    };
  });
  return {
    ...fallback,
    ...source,
    title: clean(source.title, fallback.title).slice(0, 100),
    concept: clean(source.concept, fallback.concept).slice(0, 700),
    tone: clean(source.tone, fallback.tone).slice(0, 160),
    palette: Array.isArray(source.palette) && source.palette.length >= 2 && source.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) ? source.palette.slice(0, 4) : fallback.palette,
    musicDirection: clean(source.musicDirection, fallback.musicDirection).slice(0, 500),
    music: {
      ...fallback.music,
      ...(source.music && typeof source.music === "object" ? source.music : {}),
      bpm: musicBpm,
      keyscale: clean(source.music?.keyscale, fallback.music.keyscale).slice(0, 32),
      timesignature: "4/4",
      mood: clean(source.music?.mood, fallback.music.mood).slice(0, 180),
      energyCurve: clean(source.music?.energyCurve, fallback.music.energyCurve).slice(0, 300),
      instruments: Array.isArray(source.music?.instruments) ? source.music.instruments.map(item => clean(item)).filter(Boolean).slice(0, 6) : fallback.music.instruments,
      avoid: Array.isArray(source.music?.avoid) ? source.music.avoid.map(item => clean(item)).filter(Boolean).slice(0, 8) : fallback.music.avoid
    },
    typography: { ...fallback.typography, ...(source.typography && typeof source.typography === "object" ? source.typography : {}) },
    narration: { enabled: Boolean(options.narrationEnabled ?? source.narration?.enabled), script: clean(source.narration?.script).slice(0, 1200) },
    durationSeconds,
    aspectRatio: ["9:16", "1:1", "4:5", "16:9"].includes(options.aspectRatio || source.aspectRatio) ? (options.aspectRatio || source.aspectRatio) : "9:16",
    fps: [24, 25, 30, 50, 60].includes(Number(options.fps || source.fps)) ? Number(options.fps || source.fps) : config.videoDefaultFps,
    shots: normalized
  };
}

async function qwenVideoPlan(brief, options) {
  const duration = options.durationSeconds || config.videoDefaultDurationSeconds;
  const short = duration <= 20;
  const prompt = `You are the creative director, product cinematographer, music supervisor and editing director for a premium product film. Return JSON only. Build one coherent PRODUCT-CENTRIC narrative: mystery, authentic detail, craft, complete form, hero reveal and brand resolve. Never invent a person, character, location, alternate product or unsupported product angle. Every visual must be derived from the supplied product asset. The film must not be a slideshow: vary real crops, focus, scale, light, depth and typography while preserving identity. Ground every claim in the brief. Duration: exactly ${duration} seconds. Use ${short ? "exactly 6" : "8"} PRODUCT shots only. Use HYBRID for product cinematography and DETERMINISTIC for the lockup; never use GENERATIVE or PEOPLE. Design a matching instrumental score: specify mood, BPM, key, instruments, sounds to avoid and an energy curve whose hero lift and final resolve match the storyboard. For each shot specify a normalized focus {x:0..1,y:0..1,zoom:1..3}, composition, lighting, camera, motion, cut intention, music cue, sound cues, continuity constraints and rejection criteria. Typography is composited separately. Schema: {title,concept,tone,palette:[hex],musicDirection,music:{mood,bpm,keyscale,timesignature,instruments:[],avoid:[],energyCurve},typography:{headlineFamily,utilityFamily,style},storyArc,continuity:{lighting,product,source},narration:{enabled,script},durationSeconds,aspectRatio,fps,shots:[{id,purpose,sceneType:"PRODUCT",durationSeconds,renderMode:"HYBRID"|"DETERMINISTIC",prompt,negativePrompt,seed,camera,motion,focus:{x,y,zoom},composition,lighting,cutIntention,musicCue:{beat,role},soundCues:[],continuityConstraints:[],rejectionCriteria:[],copy:{eyebrow,headline,subheadline}}]}. Brief: ${JSON.stringify(brief)}. Options: ${JSON.stringify(options)}.`;
  const response = await fetch(`${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Release the local model immediately after planning so the 6 GB GPU is
    // available to FramePack instead of waiting for Ollama's idle timeout.
    body: JSON.stringify({ model: config.ollamaPlannerModel, stream: false, format: "json", keep_alive: 0, messages: [{ role: "user", content: prompt }], options: { temperature: 0.2, num_predict: 2200 } }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Ollama planner returned ${response.status}.`);
  const payload = await response.json();
  return JSON.parse(payload.message?.content || "{}");
}

export async function createAutonomousVideoPlan(brief, options = {}) {
  const warnings = [];
  if (config.videoPostEnabled && config.autonomousVideoPlanning && options.useAi !== false) {
    try {
      const planned = await qwenVideoPlan(brief, options);
      return { plan: normalizeVideoPlan(planned, brief, options), agentic: { planner: "qwen3", autonomous: true }, warnings };
    } catch (error) {
      warnings.push(`Local Qwen3 planner used deterministic fallback: ${error.message}`);
    }
  }
  return { plan: createDeterministicVideoPlan(brief, options), agentic: { planner: "deterministic", autonomous: true }, warnings };
}
