import { config } from "./config.js";
import { productIdentity } from "./brief.js";
import { withEditableTimeline } from "./video-timeline.js";

const longFormShotBlueprints = [
  { purpose: "mystery-hook", weight: 4, renderMode: "HYBRID", camera: "locked macro", motion: "edge-light reveal", focus: { x: .5, y: .58, zoom: 2.4 } },
  { purpose: "material-detail", weight: 4, renderMode: "GENERATIVE", camera: "macro lateral slide", motion: "grazing light across texture", focus: { x: .5, y: .68, zoom: 2.7 } },
  { purpose: "construction-detail", weight: 4, renderMode: "GENERATIVE", camera: "precision track", motion: "natural fabric and cuff movement with a controlled detail inspection", focus: { x: .74, y: .72, zoom: 2.5 } },
  { purpose: "feature-one", weight: 5, renderMode: "HYBRID", camera: "measured push-in", motion: "feature-led depth drift", focus: { x: .48, y: .66, zoom: 1.75 } },
  { purpose: "feature-two", weight: 5, renderMode: "GENERATIVE", camera: "slow lateral move", motion: "secondary feature reveal", focus: { x: .32, y: .7, zoom: 1.9 } },
  { purpose: "full-form", weight: 6, renderMode: "GENERATIVE", camera: "slow centered dolly", motion: "complete product form emerges with restrained natural movement", focus: { x: .5, y: .62, zoom: 1.12 } },
  { purpose: "hero-reveal", weight: 7, renderMode: "GENERATIVE", camera: "controlled hero push", motion: "shadow recedes into clarity while the product remains geometrically stable", focus: { x: .5, y: .62, zoom: 1.08 } },
  { purpose: "brand-lockup", weight: 4, renderMode: "DETERMINISTIC", camera: "locked", motion: "precise type and tonal resolve", focus: { x: .5, y: .62, zoom: 1.08 } }
];

// Product-first films never invent unrelated people. Every shot is derived from
// the supplied product asset and advances from detail to complete form.
const shortFormShotBlueprints = [
  { purpose: "mystery-hook", weight: 3, renderMode: "HYBRID", camera: "locked macro", motion: "warm edge light reveals one signature detail", focus: { x: .5, y: .58, zoom: 2.4 }, cutIntention: "open from black on the first tactile sound" },
  { purpose: "material-detail", weight: 4, renderMode: "GENERATIVE", camera: "macro lateral slide", motion: "controlled grazing light reveals texture and craft", focus: { x: .5, y: .68, zoom: 2.7 }, cutIntention: "cut as the highlight reaches the detail" },
  { purpose: "construction-detail", weight: 4, renderMode: "GENERATIVE", camera: "precision track", motion: "natural fabric and cuff movement completes the craft story", focus: { x: .74, y: .72, zoom: 2.5 }, cutIntention: "match the direction of the previous movement" },
  { purpose: "feature-impact", weight: 3, renderMode: "HYBRID", camera: "measured push-in", motion: "feature statement arrives on a restrained accent", focus: { x: .48, y: .66, zoom: 1.75 }, cutIntention: "hard cut on the strongest musical transient" },
  { purpose: "hero-reveal", weight: 6, renderMode: "GENERATIVE", camera: "slow centered dolly", motion: "the complete product emerges from shadow with restrained natural movement", focus: { x: .5, y: .62, zoom: 1.12 }, cutIntention: "hold through the musical lift" },
  { purpose: "brand-lockup", weight: 4, renderMode: "DETERMINISTIC", camera: "locked", motion: "minimal light resolve and precise type entrance", focus: { x: .5, y: .62, zoom: 1.08 }, cutIntention: "resolve cleanly and leave visual breathing room" }
];

const palettes = [
  ["#050505", "#F5F2EA", "#9EA7B3"],
  ["#EEEAE1", "#111113", "#A16F42"],
  ["#0B1020", "#F5F7FB", "#6EB8FF"],
  ["#171217", "#FFF8EC", "#D9B46D"]
];

const clean = (value, fallback = "") => String(value || fallback).replace(/\s+/g, " ").trim();
const clamp = (value, min, max) => {
  const numeric = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : min));
};
const validRenderModes = new Set(["GENERATIVE", "HYBRID", "DETERMINISTIC"]);
const validBackgroundStyles = new Set(["STUDIO_VOID", "NEON_GRADIENT", "SOFT_HALO", "LIGHT_TUNNEL", "ARCHITECTURAL_GRID", "MONOCHROME", "MACRO_SURFACE"]);
const validEditStyles = new Set(["MACRO_PUSH", "LATERAL_SLIDE", "DIAGONAL_DRIFT", "LOCKED_LIGHT", "HERO_PULLBACK", "ENERGY_PULSE", "PRECISION_TRACK"]);
const validTransitions = new Set(["CUT", "DISSOLVE", "FADE_BLACK", "FADE_WHITE", "WIPE_LEFT", "WIPE_UP", "SLIDE_LEFT", "SMOOTH_LEFT", "CIRCLE_OPEN", "RADIAL", "PIXELIZE"]);

function nearestLtxFrameCount(value, durationSeconds, fps) {
  const requested = Number(value) || Math.round(durationSeconds * fps);
  const normalized = Math.round((requested - 1) / 8) * 8 + 1;
  return Math.max(33, Math.min(121, normalized));
}

function normalizedKeyscale(value, fallback = "D minor") {
  return String(value || "").match(/\b[A-G](?:#|b)?\s+(?:major|minor)\b/i)?.[0] || fallback;
}

function productSafeDirection(value, fallback = "") {
  return clean(value, fallback).replace(/\b(?:gamer|person|people|human|user|model|wearer|hands?)\b/gi, "product");
}

function hash(text) {
  return [...String(text)].reduce((total, character) => ((total * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function categoryMusicProfile(brief, defaultBpm) {
  const category = `${brief.category || ""} ${brief.product || ""} ${brief.tone || ""}`.toLowerCase();
  if (/(laptop|computer|gaming|phone|electronics|keyboard|monitor|headphone)/.test(category)) return {
    musicDirection: "A precise futuristic electronic product score built from a restrained synth pulse, mechanical detail percussion, low sub energy and a controlled cinematic lift; instrumental, no vocals.",
    mood: "precise, futuristic, powerful and controlled", bpm: Math.max(104, defaultBpm), keyscale: "F minor",
    instruments: ["restrained analog pulse", "precise mechanical percussion", "low sub bass", "glassy digital texture", "cinematic synth lift"],
    avoid: ["festival EDM", "retro arcade melody", "generic corporate music", "vocals", "busy drums"],
    energyCurve: "dark power-on, accumulating technical pulse, decisive feature accents, wide hero lift, clean digital resolve"
  };
  if (/(fashion|apparel|garment|dress|shoe|luxury|jewelry|watch|beauty|perfume)/.test(category)) return {
    musicDirection: "A spacious editorial score with tactile percussion, sculpted low end and restrained melodic fragments that leave room for fabric, material and visual rhythm; instrumental, no vocals.",
    mood: "editorial, tactile, elegant and assured", bpm: Math.min(110, defaultBpm), keyscale: "D minor",
    instruments: ["tactile percussion", "warm analog bass", "felt piano fragments", "airy granular texture"],
    avoid: ["runway cliché", "corporate ukulele", "festival EDM", "vocals"],
    energyCurve: "near-silent material onset, rhythmic detail build, elegant hero lift, spacious final hold"
  };
  if (/(food|drink|coffee|restaurant|snack|beverage)/.test(category)) return {
    musicDirection: "A warm sensory instrumental with organic percussion, rounded bass and light melodic detail synchronized to tactile preparation and product reveals.",
    mood: "warm, sensory, inviting and rhythmic", bpm: Math.min(112, defaultBpm), keyscale: "A minor",
    instruments: ["organic hand percussion", "rounded bass", "muted keys", "tactile foley textures"],
    avoid: ["children's music", "generic corporate music", "aggressive drums", "vocals"],
    energyCurve: "sensory opening, appetizing rhythmic build, satisfying reveal, warm resolve"
  };
  return {
    musicDirection: "Warm premium editorial score with tactile percussion, restrained melodic movement, spacious dynamics, a clear lift for the hero reveal and a clean final resolve; instrumental, no vocals.",
    mood: "warm, refined, tactile and quietly confident", bpm: defaultBpm, keyscale: "D minor",
    instruments: ["muted tactile percussion", "warm analog pulse", "soft felt keys", "subtle material textures"],
    avoid: ["generic corporate ukulele", "festival EDM", "busy drums", "vocals", "abrupt genre changes"],
    energyCurve: "near-silent mystery, gradual textural build, controlled lift at the full product reveal, elegant two-second resolve"
  };
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
  const baseMusicBpm = durationSeconds <= 20 ? 96 : 120;
  const musicProfile = categoryMusicProfile(brief, baseMusicBpm);
  const musicBpm = musicProfile.bpm;
  const durations = exactDurations(durationSeconds, shotBlueprints, musicBpm);
  const identity = productIdentity(brief);
  const rigidTechnology = /(?:laptop|computer|electronics|phone|tablet|headphone|gaming|keyboard|monitor)/i.test(`${brief.category || ""} ${brief.product || ""}`);
  const technologyMotions = [
    "a narrow RGB edge light reveals the fixed chassis",
    "controlled reflections travel across the exact material finish",
    "the camera tracks across precise construction details while every component remains fixed",
    "depth and light isolate one verified feature without changing the product",
    "a lateral camera move reveals the keyboard and hinge geometry",
    "the complete product resolves through restrained atmospheric depth",
    "a clean hero light sweep settles across the unchanged product",
    "minimal light resolves into a precise brand hold"
  ];
  const palette = palettes[hash(identity) % palettes.length];
  const featureHeadlines = [
    clean(brief.features?.[0], "Designed with intention"),
    clean(brief.features?.[1], "Precision in every detail"),
    clean(brief.features?.[2], "Made for the way you move")
  ];
  const longHeadlines = ["", featureHeadlines[0], featureHeadlines[1], featureHeadlines[2], clean(brief.colorway), clean(brief.brand), clean(brief.product, identity), clean(brief.callToAction, "Discover the details")];
  const shortHeadlines = ["", featureHeadlines[0], featureHeadlines[1], featureHeadlines[2], clean(brief.product, identity), clean(brief.callToAction, "Discover")];
  const headlines = durationSeconds <= 20 ? shortHeadlines : longHeadlines;
  return withEditableTimeline({
    title: `${identity} — considered motion`,
    concept: `A restrained premium product film built around ${identity}, using precise light, material detail and generous negative space.`,
    tone: clean(brief.tone, "premium, minimal, confident"),
    palette,
    musicDirection: musicProfile.musicDirection,
    music: {
      mood: musicProfile.mood,
      bpm: musicProfile.bpm,
      keyscale: musicProfile.keyscale,
      timesignature: "4/4",
      instruments: musicProfile.instruments,
      avoid: musicProfile.avoid,
      energyCurve: musicProfile.energyCurve
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
      stage: {
        backgroundStyle: ["STUDIO_VOID", "MACRO_SURFACE", "NEON_GRADIENT", "ARCHITECTURAL_GRID", "LIGHT_TUNNEL", "SOFT_HALO", "MONOCHROME", "STUDIO_VOID"][index % 8],
        productScale: [1.05, 1.28, 1.18, 1.12, 1.08, 1.0, .96, .9][index % 8],
        productX: [.5, .46, .56, .43, .58, .5, .5, .5][index % 8],
        productY: [.49, .48, .5, .51, .47, .49, .48, .48][index % 8],
        rotationDegrees: [0, -2.5, 2, -1, 1.5, 0, 0, 0][index % 8],
        detailMode: shot.focus.zoom > 1.8 ? "DETAIL" : "FULL"
      },
      edit: {
        style: ["MACRO_PUSH", "LATERAL_SLIDE", "PRECISION_TRACK", "DIAGONAL_DRIFT", "ENERGY_PULSE", "HERO_PULLBACK", "LOCKED_LIGHT", "LOCKED_LIGHT"][index % 8],
        transitionOut: index === shotBlueprints.length - 1 ? "CUT" : ["DISSOLVE", "SMOOTH_LEFT", "CUT", "RADIAL", "SLIDE_LEFT", "FADE_BLACK", "CIRCLE_OPEN"][index % 7],
        transitionDuration: index === shotBlueprints.length - 1 ? 0 : .35
      },
      generation: {
        frames: nearestLtxFrameCount(null, durations[index], 16),
        fps: 16,
        steps: 8,
        candidates: /hero/i.test(shot.purpose) ? 3 : 2,
        motionIntensity: /hero|impact/i.test(shot.purpose) ? "moderate" : "subtle"
      },
      productAssetIds: [],
      referenceAssetIds: [],
      prompt: `${identity}. ${shot.purpose} product advertising shot. ${shot.camera}. ${rigidTechnology ? technologyMotions[index % technologyMotions.length] : shot.motion}. ${clean(brief.tone)}. Use only the supplied product reference. Preserve exact product identity, material, silhouette and color. No invented people, locations, text or alternate views.`,
      negativePrompt: "text, letters, words, logo, watermark, duplicate product, extra product, deformed geometry, changing materials, unstable lighting, jitter, flicker",
      seed: hash(`${identity}:${shot.purpose}`),
      camera: shot.camera,
      motion: rigidTechnology ? technologyMotions[index % technologyMotions.length] : shot.motion,
      focus: shot.focus,
      composition: shot.focus.zoom > 1.8 ? "A real product detail fills the upper two-thirds with disciplined negative space for one short feature line." : "The supplied product dominates the frame with clean editorial negative space.",
      lighting: index < 2 ? "Low-key grazing copper edge light." : index === shotBlueprints.length - 1 ? "Clean soft key with controlled falloff." : "Directional premium practical light with consistent warm highlights.",
      cutIntention: shot.cutIntention || "Cut on motivated action or musical punctuation.",
      soundCues: rigidTechnology
        ? index === 0 ? ["low digital power-on", "sub-bass air"] : index === shotBlueprints.length - 1 ? ["clean digital resolve"] : ["precise synthetic click", "restrained data sweep"]
        : index === 0 ? ["low metallic onset", "subtle room tone"] : index === shotBlueprints.length - 1 ? ["soft tonal resolve"] : ["restrained tactile accent"],
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
  });
}

export function normalizeVideoPlan(value, brief, options = {}) {
  const fallback = createDeterministicVideoPlan(brief, options);
  const source = value && typeof value === "object" ? value : {};
  const durationSeconds = clamp(options.durationSeconds || source.durationSeconds || fallback.durationSeconds, 8, 60);
  const suppliedShots = Array.isArray(source.shots) ? source.shots : [];
  const productOnly = suppliedShots.every(shot => !shot.sceneType || String(shot.sceneType).toUpperCase() === "PRODUCT");
  const rawShots = suppliedShots.length >= 5 && suppliedShots.length <= 12 && productOnly ? suppliedShots : fallback.shots;
  const normalized = rawShots.map((shot, index) => {
    const base = fallback.shots[Math.min(index, fallback.shots.length - 1)];
    return {
      ...base,
      ...shot,
      id: clean(shot.id, `shot_${String(index + 1).padStart(2, "0")}`).replace(/[^a-z0-9_-]/gi, "_").slice(0, 50),
      order: index + 1,
      purpose: productSafeDirection(shot.purpose, base.purpose).slice(0, 50),
      sceneType: "PRODUCT",
      durationSeconds: clamp(shot.durationSeconds || base.durationSeconds, 1.5, durationSeconds),
      renderMode: validRenderModes.has(String(shot.renderMode).toUpperCase()) ? String(shot.renderMode).toUpperCase() : base.renderMode,
      prompt: productSafeDirection(shot.prompt, base.prompt).slice(0, 1800),
      negativePrompt: clean(shot.negativePrompt, base.negativePrompt).slice(0, 500),
      seed: Number.isInteger(Number(shot.seed)) ? Number(shot.seed) : base.seed,
      camera: clean(shot.camera, base.camera).slice(0, 100),
      motion: productSafeDirection(shot.motion, base.motion).slice(0, 100),
      focus: {
        x: clamp(shot.focus?.x ?? base.focus?.x ?? .5, 0, 1),
        y: clamp(shot.focus?.y ?? base.focus?.y ?? .5, 0, 1),
        zoom: clamp(shot.focus?.zoom ?? base.focus?.zoom ?? 1, 1, 3)
      },
      stage: {
        backgroundStyle: validBackgroundStyles.has(String(shot.stage?.backgroundStyle).toUpperCase()) ? String(shot.stage.backgroundStyle).toUpperCase() : base.stage.backgroundStyle,
        productScale: clamp(shot.stage?.productScale ?? base.stage.productScale, .65, 1.5),
        productX: clamp(shot.stage?.productX ?? base.stage.productX, .1, .9),
        productY: clamp(shot.stage?.productY ?? base.stage.productY, .15, .82),
        rotationDegrees: clamp(shot.stage?.rotationDegrees ?? base.stage.rotationDegrees, -8, 8),
        detailMode: ["FULL", "DETAIL", "SILHOUETTE"].includes(String(shot.stage?.detailMode).toUpperCase()) ? String(shot.stage.detailMode).toUpperCase() : base.stage.detailMode
      },
      edit: {
        style: validEditStyles.has(String(shot.edit?.style).toUpperCase()) ? String(shot.edit.style).toUpperCase() : base.edit.style,
        transitionOut: validTransitions.has(String(shot.edit?.transitionOut).toUpperCase()) ? String(shot.edit.transitionOut).toUpperCase() : base.edit.transitionOut,
        transitionDuration: clamp(shot.edit?.transitionDuration ?? base.edit.transitionDuration, 0, .9)
      },
      generation: {
        fps: [16, 20, 24, 30].includes(Number(shot.generation?.fps)) ? Number(shot.generation.fps) : 16,
        frames: Number(shot.generation?.frames) || null,
        steps: 8,
        candidates: clamp(shot.generation?.candidates ?? (/hero/i.test(shot.purpose) ? 3 : 2), 1, 3),
        motionIntensity: ["subtle", "moderate", "dynamic"].includes(String(shot.generation?.motionIntensity).toLowerCase()) ? String(shot.generation.motionIntensity).toLowerCase() : "subtle"
      },
      copy: {
        eyebrow: clean(shot.copy?.eyebrow, base.copy.eyebrow).slice(0, 32),
        headline: clean(shot.copy?.headline, base.copy.headline).slice(0, 64),
        subheadline: clean(shot.copy?.subheadline, base.copy.subheadline).slice(0, 90)
      },
      soundCues: Array.isArray(shot.soundCues) && shot.soundCues.some(Boolean) ? shot.soundCues.map(item => clean(item)).filter(Boolean).slice(0, 5) : base.soundCues,
      continuityConstraints: Array.isArray(shot.continuityConstraints) && shot.continuityConstraints.some(Boolean) ? shot.continuityConstraints.map(item => clean(item)).filter(Boolean).slice(0, 8) : base.continuityConstraints,
      rejectionCriteria: Array.isArray(shot.rejectionCriteria) && shot.rejectionCriteria.some(Boolean) ? shot.rejectionCriteria.map(item => clean(item)).filter(Boolean).slice(0, 10) : base.rejectionCriteria,
      productAssetIds: [],
      referenceAssetIds: [],
      status: "PLANNED",
      attempts: 0
    };
  });
  normalized[normalized.length - 1].renderMode = "DETERMINISTIC";
  const minimumGenerative = Math.ceil(normalized.length * .45);
  const maximumGenerative = Math.max(minimumGenerative, Math.floor(normalized.length * .75));
  let generativeCount = normalized.filter(shot => shot.renderMode === "GENERATIVE").length;
  for (let index = 1; generativeCount < minimumGenerative && index < normalized.length - 1; index += 1) {
    if (normalized[index].renderMode !== "GENERATIVE") {
      normalized[index].renderMode = "GENERATIVE";
      generativeCount += 1;
    }
  }
  for (let index = normalized.length - 2; generativeCount > maximumGenerative && index >= 0; index -= 1) {
    if (normalized[index].renderMode === "GENERATIVE" && !/hero/i.test(normalized[index].purpose)) {
      normalized[index].renderMode = "HYBRID";
      generativeCount -= 1;
    }
  }
  const musicBpm = clamp(source.music?.bpm || fallback.music.bpm, 60, 160);
  const alignedDurations = exactDurations(durationSeconds, normalized.map(shot => ({ weight: shot.durationSeconds })), musicBpm);
  const distinctFocusCount = new Set(normalized.map(shot => `${shot.focus.x.toFixed(2)}:${shot.focus.y.toFixed(2)}:${shot.focus.zoom.toFixed(2)}`)).size;
  if (distinctFocusCount < Math.min(4, normalized.length)) {
    normalized.forEach((shot, index) => { shot.focus = { ...fallback.shots[Math.min(index, fallback.shots.length - 1)].focus }; });
  }
  const diversityStyles = ["STUDIO_VOID", "NEON_GRADIENT", "SOFT_HALO", "LIGHT_TUNNEL", "ARCHITECTURAL_GRID", "MONOCHROME", "MACRO_SURFACE"];
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1].stage;
    const current = normalized[index].stage;
    const repeated = current.backgroundStyle === previous.backgroundStyle
      && Math.abs(current.productScale - previous.productScale) < .16
      && Math.abs(current.productX - previous.productX) < .12
      && Math.abs(current.productY - previous.productY) < .12;
    if (repeated) {
      current.backgroundStyle = diversityStyles[(diversityStyles.indexOf(previous.backgroundStyle) + 2 + index) % diversityStyles.length];
      current.productScale = clamp(current.productScale + (index % 2 ? -.22 : .22), .65, 1.5);
      current.productX = clamp(current.productX + (index % 2 ? -.16 : .16), .1, .9);
      current.productY = clamp(current.productY + (index % 2 ? .08 : -.08), .15, .82);
      current.rotationDegrees = clamp(current.rotationDegrees + (index % 2 ? -3 : 3), -8, 8);
    }
  }
  normalized.forEach((shot, index) => {
    shot.durationSeconds = alignedDurations[index];
    shot.generation.frames = nearestLtxFrameCount(shot.generation.frames, shot.durationSeconds, shot.generation.fps);
    if (shot.edit.transitionOut === "CUT") shot.edit.transitionDuration = 0;
    if (index === normalized.length - 1) shot.edit = { ...shot.edit, transitionOut: "CUT", transitionDuration: 0 };
    shot.musicCue = {
      beat: Math.round(alignedDurations.slice(0, index).reduce((total, value) => total + value, 0) / (60 / musicBpm)),
      role: clean(shot.musicCue?.role, index === normalized.length - 2 ? "hero lift" : index === normalized.length - 1 ? "final resolve" : "tactile cut")
    };
  });
  return withEditableTimeline({
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
      keyscale: normalizedKeyscale(source.music?.keyscale, fallback.music.keyscale),
      timesignature: ["3/4", "4/4"].includes(source.music?.timesignature) ? source.music.timesignature : "4/4",
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
  });
}

async function ollamaJson(prompt, { numPredict, temperature, keepAlive = 0 } = {}) {
  const response = await fetch(`${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.ollamaPlannerModel, stream: false, format: "json", keep_alive: keepAlive, messages: [{ role: "user", content: `/no_think\n${prompt}` }], options: { temperature, num_predict: numPredict } }),
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw new Error(`Ollama planner returned ${response.status}.`);
  const payload = await response.json();
  const parsed = JSON.parse(payload.message?.content || "{}");
  if (!parsed || typeof parsed !== "object" || !Object.keys(parsed).length) throw new Error("Qwen returned an empty director draft.");
  return parsed;
}

export async function qwenVideoPlan(brief, options) {
  const durationInstruction = options.durationSeconds
    ? `The runtime is exactly ${options.durationSeconds} seconds.`
    : "Choose durationSeconds from 12 to 60. Prefer 18–40 seconds and use longer only when the story earns it.";
  const treatment = await ollamaJson(`Act as creative director for a premium product advertisement. Return JSON only. Use only supplied facts and do not copy an existing campaign. ${durationInstruction} Choose shotCount from 5 to 12. Create a cinematic story, not a slideshow.

Return exactly these keys: title, concept, tone, palette (3 hex colors), durationSeconds, shotCount, storyArc, categoryArchetype, visualThesis, pacing, editGrammar, productTreatment, colorProgression.

Product brief: ${JSON.stringify(brief)}.`, { numPredict: 1200, temperature: .3, keepAlive: "5m" });

  const durationSeconds = clamp(options.durationSeconds || treatment.durationSeconds || config.videoDefaultDurationSeconds, 8, 60);
  const shotCount = Math.round(clamp(treatment.shotCount || (durationSeconds <= 20 ? 6 : 8), 5, 12));
  const musicDraft = await ollamaJson(`Act as music supervisor for this product film. Return JSON only. Choose an original instrumental direction from the product category and story, with energy changes that support the edit. Never name or imitate an existing song.

Return {musicDirection,music:{mood,bpm,keyscale,timesignature,instruments:[],avoid:[],energyCurve},typography:{headlineFamily,utilityFamily,style},narration:{enabled,script},continuity:{lighting,product,source}}.

Product brief: ${JSON.stringify(brief)}. Creative direction: ${JSON.stringify(treatment)}.`, { numPredict: 1400, temperature: .28, keepAlive: "5m" });
  const approvedTreatment = {
    ...treatment,
    ...musicDraft,
    creativeStrategy: {
      categoryArchetype: treatment.categoryArchetype,
      visualThesis: treatment.visualThesis,
      pacing: treatment.pacing,
      editGrammar: treatment.editGrammar,
      productTreatment: treatment.productTreatment,
      colorProgression: treatment.colorProgression
    }
  };
  const shotsDraft = await ollamaJson(`You are the cinematographer and picture editor executing this approved product-film treatment. Return JSON only with exactly ${shotCount} shots totaling ${durationSeconds} seconds. Every sceneType is PRODUCT. Use only supplied facts. At least half the shots must be GENERATIVE; the final shot must be DETERMINISTIC. Avoid repeated full-frame source photographs: use authentic detail crops and a background-removed exact product cut-out in varied designed stages. Never invent an unsupported product angle or component.

Make the edit feel cinematic: alternate scale, direction and pacing; use motivated match cuts and transitions; create a clear build and hero payoff. For every GENERATIVE shot write a chronological English prompt covering starting composition, fixed product identity, environment, light, camera path, motion over time and final settling pose. LTX is strongest at camera movement, depth, atmosphere, reflections and lighting. Rigid products never bend, open, close or rebuild; garments never change construction. Generated pixels contain no new text.

Allowed backgroundStyle: STUDIO_VOID, NEON_GRADIENT, SOFT_HALO, LIGHT_TUNNEL, ARCHITECTURAL_GRID, MONOCHROME, MACRO_SURFACE. Allowed detailMode: FULL, DETAIL, SILHOUETTE. Allowed edit style: MACRO_PUSH, LATERAL_SLIDE, DIAGONAL_DRIFT, LOCKED_LIGHT, HERO_PULLBACK, ENERGY_PULSE, PRECISION_TRACK. Allowed transitionOut: CUT, DISSOLVE, FADE_BLACK, FADE_WHITE, WIPE_LEFT, WIPE_UP, SLIDE_LEFT, SMOOTH_LEFT, CIRCLE_OPEN, RADIAL, PIXELIZE. generation.frames is one of 33,49,65,81,97,121; fps is 16,20,24,30; steps is 8; candidates is 2 or 3.

Return {shots:[{id,purpose,sceneType:"PRODUCT",durationSeconds,renderMode:"GENERATIVE"|"HYBRID"|"DETERMINISTIC",prompt,negativePrompt,seed,camera,motion,focus:{x,y,zoom},stage:{backgroundStyle,productScale,productX,productY,rotationDegrees,detailMode},edit:{style,transitionOut,transitionDuration},generation:{frames,fps,steps,candidates,motionIntensity},composition,lighting,cutIntention,musicCue:{beat,role},soundCues:[],continuityConstraints:[],rejectionCriteria:[],copy:{eyebrow,headline,subheadline}}]}.

Brief: ${JSON.stringify(brief)}. Approved treatment: ${JSON.stringify(approvedTreatment)}.`, { numPredict: 7000, temperature: .28, keepAlive: 0 });
  if (!Array.isArray(shotsDraft.shots) || shotsDraft.shots.length < 5) throw new Error("Qwen returned no usable shot list.");
  return {
    ...approvedTreatment,
    durationSeconds,
    aspectRatio: options.aspectRatio || "9:16",
    fps: options.fps || config.videoDefaultFps,
    shots: shotsDraft.shots
  };
}

export async function createAutonomousVideoPlan(brief, options = {}) {
  const warnings = [];
  if (config.videoFastTemplateMode) {
    const plan = createDeterministicVideoPlan(brief, {
      ...options,
      durationSeconds: options.durationSeconds || 15
    });
    plan.shots = plan.shots.map((shot, index) => ({
      ...shot,
      renderMode: index === plan.shots.length - 1 ? "DETERMINISTIC" : "HYBRID"
    }));
    return {
      plan: withEditableTimeline(plan),
      agentic: { planner: "fast-product-template", autonomous: true, directorPasses: 0 },
      warnings
    };
  }
  if (config.videoPostEnabled && config.autonomousVideoPlanning && options.useAi !== false) {
    try {
      const planned = await qwenVideoPlan(brief, options);
      return { plan: normalizeVideoPlan(planned, brief, options), agentic: { planner: "qwen3-director-suite", autonomous: true, directorPasses: 3 }, warnings };
    } catch (error) {
      warnings.push(`Local Qwen3 planner used deterministic fallback: ${error.message}`);
    }
  }
  return { plan: createDeterministicVideoPlan(brief, options), agentic: { planner: "deterministic", autonomous: true }, warnings };
}
