import { config } from "./config.js";
import { productIdentity } from "./brief.js";

const shotBlueprints = [
  { purpose: "human-hook", sceneType: "PEOPLE", weight: 5, renderMode: "GENERATIVE", camera: "handheld follow", motion: "confident natural movement" },
  { purpose: "product-reveal", sceneType: "PRODUCT", weight: 6, renderMode: "HYBRID", camera: "macro push-in", motion: "slow light sweep" },
  { purpose: "human-story", sceneType: "PEOPLE", weight: 7, renderMode: "GENERATIVE", camera: "lateral tracking", motion: "authentic everyday action" },
  { purpose: "material-detail", sceneType: "PRODUCT", weight: 6, renderMode: "HYBRID", camera: "macro lateral slide", motion: "material detail" },
  { purpose: "human-connection", sceneType: "PEOPLE", weight: 7, renderMode: "GENERATIVE", camera: "measured orbit", motion: "warm social interaction" },
  { purpose: "craft", sceneType: "PRODUCT", weight: 6, renderMode: "HYBRID", camera: "precision track", motion: "subtle environmental motion" },
  { purpose: "human-payoff", sceneType: "PEOPLE", weight: 7, renderMode: "GENERATIVE", camera: "slow rise", motion: "cinematic atmosphere" },
  { purpose: "hero", sceneType: "PRODUCT", weight: 7, renderMode: "DETERMINISTIC", camera: "slow dolly", motion: "product-preserving parallax" },
  { purpose: "feature-payoff", sceneType: "PRODUCT", weight: 5, renderMode: "HYBRID", camera: "controlled orbit", motion: "rim-light reveal" },
  { purpose: "lockup", sceneType: "PRODUCT", weight: 4, renderMode: "DETERMINISTIC", camera: "locked", motion: "minimal light and type reveal" }
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

function exactDurations(totalSeconds) {
  // 120 BPM gives a 0.5-second beat. Allocate whole beats with one beat per shot,
  // then distribute the remaining beats proportionally by dramatic weight.
  const totalBeats = Math.max(shotBlueprints.length, Math.round(totalSeconds * 2));
  const remaining = totalBeats - shotBlueprints.length;
  const weightTotal = shotBlueprints.reduce((sum, shot) => sum + shot.weight, 0);
  const quotas = shotBlueprints.map(shot => (shot.weight / weightTotal) * remaining);
  const beats = quotas.map(quota => 1 + Math.floor(quota));
  let unassigned = totalBeats - beats.reduce((sum, value) => sum + value, 0);
  quotas.map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, unassigned)
    .forEach(({ index }) => { beats[index] += 1; });
  const durations = beats.map(value => value / 2);
  const priorTotal = durations.slice(0, -1).reduce((sum, value) => sum + value, 0);
  durations[durations.length - 1] = Math.round((totalSeconds - priorTotal) * 100) / 100;
  return durations;
}

export function createDeterministicVideoPlan(brief, options = {}) {
  const durationSeconds = clamp(options.durationSeconds || config.videoDefaultDurationSeconds, 8, 60);
  const durations = exactDurations(durationSeconds);
  const identity = productIdentity(brief);
  const palette = palettes[hash(identity) % palettes.length];
  const featureHeadlines = [
    clean(brief.features?.[0], "Designed with intention"),
    clean(brief.features?.[1], "Precision in every detail"),
    clean(brief.features?.[2], "Made for the way you move")
  ];
  const headlines = [
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
  return {
    title: `${identity} — considered motion`,
    concept: `A restrained premium product film built around ${identity}, using precise light, material detail and generous negative space.`,
    tone: clean(brief.tone, "premium, minimal, confident"),
    palette,
    musicDirection: "Minimal cinematic pulse, tactile percussion, spacious dynamics, original instrumental, no vocals.",
    narration: { enabled: Boolean(options.narrationEnabled), script: "" },
    durationSeconds,
    aspectRatio: options.aspectRatio || "9:16",
    fps: Number(options.fps || config.videoDefaultFps),
    shots: shotBlueprints.map((shot, index) => ({
      id: `shot_${String(index + 1).padStart(2, "0")}`,
      order: index + 1,
      purpose: shot.purpose,
      sceneType: shot.sceneType,
      durationSeconds: durations[index],
      renderMode: shot.renderMode,
      productAssetIds: [],
      referenceAssetIds: [],
      prompt: shot.sceneType === "PEOPLE"
        ? `${identity}. Premium human-centered advertisement. A diverse, believable person in an authentic everyday story connected to ${clean(brief.category, brief.product)}. ${shot.camera}. ${shot.motion}. ${clean(brief.tone)}. Candid emotion, cinematic realism, natural skin and hands, vertical composition, no visible text or logos.`
        : `${identity}. ${shot.purpose} product advertising shot. ${shot.camera}. ${shot.motion}. ${clean(brief.tone)}. Exact product identity from the supplied reference, premium controlled lighting, clean negative space, cinematic realism.`,
      negativePrompt: "text, letters, words, logo, watermark, duplicate product, extra product, deformed geometry, changing materials, unstable lighting, jitter, flicker",
      seed: hash(`${identity}:${shot.purpose}`),
      camera: shot.camera,
      motion: shot.motion,
      copy: {
        eyebrow: index === 7 ? clean(brief.brand, brief.category) : "",
        headline: headlines[index].slice(0, 64),
        subheadline: index === 7 ? identity : ""
      },
      status: "PLANNED",
      attempts: 0
    }))
  };
}

export function normalizeVideoPlan(value, brief, options = {}) {
  const fallback = createDeterministicVideoPlan(brief, options);
  const source = value && typeof value === "object" ? value : {};
  const rawShots = Array.isArray(source.shots) && source.shots.length >= 3 && source.shots.length <= 12 ? source.shots : fallback.shots;
  const durationSeconds = clamp(options.durationSeconds || source.durationSeconds || fallback.durationSeconds, 8, 60);
  const normalized = rawShots.map((shot, index) => {
    const base = fallback.shots[Math.min(index, fallback.shots.length - 1)];
    return {
      ...base,
      ...shot,
      id: clean(shot.id, `shot_${String(index + 1).padStart(2, "0")}`).replace(/[^a-z0-9_-]/gi, "_").slice(0, 50),
      order: index + 1,
      purpose: clean(shot.purpose, base.purpose).slice(0, 50),
      sceneType: ["PEOPLE", "PRODUCT"].includes(shot.sceneType) ? shot.sceneType : base.sceneType,
      durationSeconds: clamp(shot.durationSeconds || base.durationSeconds, 1.5, durationSeconds),
      renderMode: ["DETERMINISTIC", "HYBRID", "GENERATIVE"].includes(shot.renderMode) ? shot.renderMode : base.renderMode,
      prompt: clean(shot.prompt, base.prompt).slice(0, 900),
      negativePrompt: clean(shot.negativePrompt, base.negativePrompt).slice(0, 500),
      seed: Number.isInteger(Number(shot.seed)) ? Number(shot.seed) : base.seed,
      camera: clean(shot.camera, base.camera).slice(0, 100),
      motion: clean(shot.motion, base.motion).slice(0, 100),
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
  return {
    ...fallback,
    ...source,
    title: clean(source.title, fallback.title).slice(0, 100),
    concept: clean(source.concept, fallback.concept).slice(0, 700),
    tone: clean(source.tone, fallback.tone).slice(0, 160),
    palette: Array.isArray(source.palette) && source.palette.length >= 2 && source.palette.every(color => /^#[0-9a-f]{6}$/i.test(color)) ? source.palette.slice(0, 4) : fallback.palette,
    musicDirection: clean(source.musicDirection, fallback.musicDirection).slice(0, 500),
    narration: { enabled: Boolean(options.narrationEnabled ?? source.narration?.enabled), script: clean(source.narration?.script).slice(0, 1200) },
    durationSeconds,
    aspectRatio: ["9:16", "1:1", "4:5", "16:9"].includes(options.aspectRatio || source.aspectRatio) ? (options.aspectRatio || source.aspectRatio) : "9:16",
    fps: [24, 25, 30, 50, 60].includes(Number(options.fps || source.fps)) ? Number(options.fps || source.fps) : config.videoDefaultFps,
    shots: normalized
  };
}

async function qwenVideoPlan(brief, options) {
  const prompt = `You are the autonomous creative director for a premium short product film with the emotional range and editing discipline of a major technology campaign. Return JSON only. Create one coherent story with real people, varied locations and actions, intercut with exact product hero shots; it must not be a slideshow. Ground every claim in the supplied brief. The final duration must be exactly ${options.durationSeconds || config.videoDefaultDurationSeconds} seconds. Use 8-10 shots, with at least three PEOPLE scenes and three PRODUCT scenes. PEOPLE scenes use renderMode GENERATIVE and must describe natural movement, believable hands, diverse casting and cinematic environments without asking for text or logos. PRODUCT hero and lockup scenes use DETERMINISTIC or HYBRID to preserve the supplied product identity. Schema: {title,concept,tone,palette:[hex],musicDirection,narration:{enabled,script},durationSeconds,aspectRatio,fps,shots:[{id,purpose,sceneType:"PEOPLE"|"PRODUCT",durationSeconds,renderMode,prompt,negativePrompt,seed,camera,motion,copy:{eyebrow,headline,subheadline}}]}. Brief: ${JSON.stringify(brief)}. Options: ${JSON.stringify(options)}.`;
  const response = await fetch(`${config.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.ollamaPlannerModel, stream: false, format: "json", messages: [{ role: "user", content: prompt }], options: { temperature: 0.25 } }),
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
