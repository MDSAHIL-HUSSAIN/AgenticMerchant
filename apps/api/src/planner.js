import { productIdentity } from "./brief.js";
import { config } from "./config.js";

const SIZE = 1080;
const SAFE = 64;
const palettes = [
  ["#0A0A0C", "#F4F1EA", "#B9FF38"],
  ["#EFE9DF", "#171719", "#FF5E3A"],
  ["#101827", "#F6F8FC", "#48D9FF"],
  ["#2A163A", "#FFF4E8", "#FF8BB6"]
];

const compositions = {
  "hero-right": { textX: 70, textY: 105, textWidth: 410, headlineSize: 78, productX: 505, productY: 190, productWidth: 505, productHeight: 650 },
  "hero-left": { textX: 600, textY: 155, textWidth: 410, headlineSize: 68, productX: 55, productY: 205, productWidth: 505, productHeight: 650 },
  split: { textX: 70, textY: 145, textWidth: 405, headlineSize: 68, productX: 535, productY: 205, productWidth: 475, productHeight: 650 },
  centered: { textX: 105, textY: 85, textWidth: 870, headlineSize: 70, productX: 240, productY: 365, productWidth: 600, productHeight: 520 },
  detail: { textX: 70, textY: 220, textWidth: 370, headlineSize: 64, productX: 490, productY: 135, productWidth: 520, productHeight: 710 },
  closing: { textX: 125, textY: 90, textWidth: 830, headlineSize: 72, productX: 275, productY: 385, productWidth: 530, productHeight: 470 }
};

function hash(text) {
  return [...text].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 7);
}

function compact(value, maxLength, fallback = "") {
  const clean = String(value || fallback).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  const shortened = clean.slice(0, maxLength - 1);
  const breakAt = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, breakAt > maxLength * 0.6 ? breakAt : shortened.length)}…`;
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function boundedBox(source, fallback, kind) {
  const isText = kind === "text";
  const x = number(source?.[`${kind}X`], fallback[`${kind}X`], SAFE, SIZE - SAFE - (isText ? 240 : 260));
  const y = number(source?.[`${kind}Y`], fallback[`${kind}Y`], SAFE, isText ? 700 : 760);
  const widthKey = `${kind}Width`;
  const heightKey = `${kind}Height`;
  const width = number(source?.[widthKey], fallback[widthKey], isText ? 240 : 260, SIZE - SAFE - x);
  const result = { [`${kind}X`]: x, [`${kind}Y`]: y, [widthKey]: width };
  if (!isText) result[heightKey] = number(source?.[heightKey], fallback[heightKey], 260, SIZE - 150 - y);
  return result;
}

function overlapRatio(composition) {
  const text = { x: composition.textX, y: composition.textY, w: composition.textWidth, h: 330 };
  const image = { x: composition.productX, y: composition.productY, w: composition.productWidth, h: composition.productHeight };
  const width = Math.max(0, Math.min(text.x + text.w, image.x + image.w) - Math.max(text.x, image.x));
  const height = Math.max(0, Math.min(text.y + text.h, image.y + image.h) - Math.max(text.y, image.y));
  return (width * height) / Math.min(text.w * text.h, image.w * image.h);
}

function normalizeComposition(value, layout) {
  const fallback = compositions[layout] || compositions["hero-right"];
  const candidate = {
    ...boundedBox(value, fallback, "text"),
    ...boundedBox(value, fallback, "product"),
    headlineSize: number(value?.headlineSize, fallback.headlineSize, 42, 82)
  };
  return overlapRatio(candidate) > 0.18 ? { ...fallback } : candidate;
}

export function scoreCandidates(candidates, brief) {
  const tokens = productIdentity(brief).toLowerCase().split(/\W+/).filter(token => token.length > 2);
  return candidates.map(candidate => {
    const haystack = `${candidate.title} ${candidate.source} ${candidate.query || ""}`.toLowerCase();
    const tokenScore = tokens.filter(token => haystack.includes(token)).length * 12;
    const areaScore = Math.min(18, Math.log2(Math.max(1, candidate.width * candidate.height)));
    const sourceScore = /official|brand|manufacturer/i.test(haystack) ? 18 : 0;
    const collagePenalty = /collection|multiple|range|all colors|catalog/i.test(haystack) ? 12 : 0;
    return { ...candidate, score: Math.round(tokenScore + areaScore + sourceScore - collagePenalty) };
  }).sort((a, b) => b.score - a.score);
}

export function createDeterministicPlan(brief) {
  const identity = productIdentity(brief);
  const palette = palettes[hash(identity) % palettes.length];
  const featureOne = compact(brief.features[0], 42, "Designed to stand apart");
  const featureTwo = compact(brief.features[1], 42, "Built for the way you move");
  const common = { accent: palette[2], background: palette[0], textColor: palette[1], overlayOpacity: 0.58, imageTreatment: "editorial-card", motif: "none" };
  const raw = [
    { ...common, kind: "hero", eyebrow: brief.brand || brief.category || "NEW EDIT", headline: brief.product, subheadline: brief.model || brief.tone, imageIndex: 0, layout: "hero-right" },
    { ...common, kind: "statement", eyebrow: "FORM / FUNCTION", headline: featureOne, subheadline: `A closer look at ${identity}.`, imageIndex: 1, layout: "hero-left" },
    { ...common, kind: "feature", eyebrow: "THE DETAILS", headline: featureTwo, subheadline: brief.features.slice(2).join(" · ") || "Considered from every angle.", imageIndex: 2, layout: "split" },
    { ...common, kind: "editorial", eyebrow: "IN MOTION", headline: "Comfort, considered.", subheadline: `Designed for ${brief.audience}.`, imageIndex: 0, layout: "centered" },
    { ...common, kind: "detail", eyebrow: "SIGNATURE PROFILE", headline: brief.colorway || "Precision in every line.", subheadline: brief.tone, imageIndex: 1, layout: "detail" },
    { ...common, kind: "closing", eyebrow: brief.brand || "THE COLLECTION", headline: brief.callToAction, subheadline: identity, imageIndex: 2, layout: "closing" }
  ];
  return raw.slice(0, config.designCount).map(item => ({ ...item, composition: { ...compositions[item.layout] } }));
}

export function normalizePlan(value, brief, assetCount = 3) {
  const fallback = createDeterministicPlan(brief);
  const designs = Array.isArray(value) ? value : value?.designs;
  if (!Array.isArray(designs) || designs.length < config.designCount) return fallback;
  const count = Math.max(1, assetCount);
  return designs.slice(0, config.designCount).map((item, index) => {
    const base = fallback[index];
    const layout = Object.hasOwn(compositions, item?.layout) ? item.layout : base.layout;
    return {
      ...base,
      ...item,
      layout,
      eyebrow: compact(item?.eyebrow, 26, base.eyebrow),
      headline: compact(item?.headline, 52, base.headline),
      subheadline: compact(item?.subheadline, 100, base.subheadline),
      accent: /^#[0-9a-f]{6}$/i.test(item?.accent || "") ? item.accent : base.accent,
      background: /^#[0-9a-f]{6}$/i.test(item?.background || "") ? item.background : base.background,
      textColor: /^#[0-9a-f]{6}$/i.test(item?.textColor || "") ? item.textColor : base.textColor,
      overlayOpacity: number(item?.overlayOpacity, base.overlayOpacity, 0.35, 0.82),
      imageTreatment: ["isolated-stage", "editorial-card", "full-bleed-crop"].includes(item?.imageTreatment) ? item.imageTreatment : base.imageTreatment,
      motif: ["none", "contour", "precision-grid", "motion-lines", "material-dots"].includes(item?.motif) ? item.motif : base.motif,
      imageIndex: index % count,
      composition: normalizeComposition(item?.composition, layout)
    };
  });
}
