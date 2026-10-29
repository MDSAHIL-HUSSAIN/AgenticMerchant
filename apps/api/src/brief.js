const clean = value => String(value || "").trim();

export function validateBrief(input) {
  if (!input || typeof input !== "object") throw new Error("A JSON product brief is required.");
  const product = clean(input.product || input.productName);
  if (product.length < 3) throw new Error("product must contain at least 3 characters.");
  return {
    product,
    brand: clean(input.brand),
    model: clean(input.model),
    category: clean(input.category),
    colorway: clean(input.colorway),
    audience: clean(input.audience || "style-conscious shoppers"),
    tone: clean(input.tone || "premium, editorial, confident"),
    features: Array.isArray(input.features) ? input.features.map(clean).filter(Boolean).slice(0, 6) : [],
    callToAction: clean(input.callToAction || "Discover the details")
  };
}

export function productIdentity(brief) {
  return [brief.brand, brief.product, brief.model, brief.colorway].filter(Boolean).join(" ");
}

export function buildQueries(brief) {
  const identity = productIdentity(brief);
  return [
    `\"${identity}\" official product`,
    `\"${identity}\" side view`,
    `\"${identity}\" top view`,
    `\"${identity}\" high resolution`
  ];
}

export function buildSceneQueries(brief) {
  const tone = brief.tone || "premium editorial";
  const colorway = brief.colorway || "neutral";
  return [
    `${tone} empty architectural studio background`,
    `${colorway} abstract gradient texture background`,
    "premium empty product podium shadow background"
  ];
}

export function buildScenePrompts(brief, productProfile = {}) {
  const visualDirection = `${brief.tone}; ${brief.colorway || "brand-neutral palette"}`;
  const observedPalette = Array.isArray(productProfile.palette) ? productProfile.palette.join(", ") : "";
  const materialMood = [productProfile.materials?.join(", "), productProfile.mood].filter(Boolean).join("; ");
  return [
    `Empty premium ecommerce studio backdrop. ${visualDirection}. Palette cues: ${observedPalette}. ${materialMood}. Abstract architectural set, dramatic soft light, restrained geometry, generous negative space. Absolutely no products, footwear, objects, text, letters, logos or people. Square composition.`,
    `Empty high-end editorial advertising background. ${visualDirection}. Palette cues: ${observedPalette}. ${materialMood}. Sculptural abstract forms, cinematic shadows, subtle energy, clean display stage. Absolutely no products, footwear, objects, text, letters, logos or people. Square composition.`,
    `Empty luxury macro-texture backdrop. ${visualDirection}. Palette cues: ${observedPalette}. ${materialMood}. Refined gradients, precision lighting, sophisticated depth and a clear display area. Absolutely no products, footwear, objects, text, letters, logos or people. Square composition.`
  ];
}
