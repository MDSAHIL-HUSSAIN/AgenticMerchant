const clean = value => String(value || "").replace(/\s+/g, " ").trim();

function requestedRole(fieldname, filename, suppliedRoles = {}) {
  const explicit = suppliedRoles[fieldname] || suppliedRoles[filename];
  if (explicit) return String(explicit).toUpperCase();
  const hint = `${fieldname} ${filename}`.toLowerCase();
  if (/logo|brand.mark/.test(hint)) return "BRAND_LOGO";
  if (/reference|inspiration|mood|style/.test(hint)) return "STYLE_REFERENCE";
  if (/detail|close.?up|material|fabric|texture/.test(hint)) return "PRODUCT_DETAIL";
  if (/variant|colour|color|angle|side|back|front|product/.test(hint)) return "PRIMARY_PRODUCT";
  if (/annotat|feedback|markup/.test(hint)) return "ANNOTATED_FEEDBACK";
  return "UNCERTAIN";
}

export function classifyUpload(file, suppliedRoles = {}) {
  const mimeType = String(file.mimetype || "application/octet-stream").toLowerCase();
  const mediaType = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "other";
  return {
    mediaType,
    role: mediaType === "image" ? requestedRole(file.fieldname, file.originalname, suppliedRoles) : mediaType === "audio" ? "PRODUCT_AUDIO" : "UNSUPPORTED",
    filename: file.originalname,
    mimeType,
    fieldname: file.fieldname,
    confidence: mediaType === "image" && requestedRole(file.fieldname, file.originalname, suppliedRoles) === "UNCERTAIN" ? 0.35 : 0.78
  };
}

function pick(pattern, text) {
  const match = text.match(pattern);
  return match ? clean(match[1]) : "";
}

export function extractBriefFacts({ metadata = {}, text = "", transcripts = [] }) {
  const combined = clean([text, ...transcripts].filter(Boolean).join(" "));
  const inferredProduct = pick(/(?:product|item|this is|new)\s*(?:is|:|-)?\s*([a-z][a-z0-9 &'/-]{2,45})/i, combined)
    || pick(/^([a-z0-9 &'/-]{2,50}(?:kurti|shirt|shoe|sneaker|bag|watch|dress|serum|bottle|phone|laptop|jacket|hoodie|top|jeans|sandal|cream|soap))/i, combined);
  const productName = clean(metadata.productName || metadata.product || inferredProduct);
  const costText = metadata.cost ?? metadata.costPrice ?? metadata.productCost ?? metadata.purchaseCost
    ?? pick(/(?:product\s+)?cost(?:\s+price)?\s*(?:is|:|-)?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,.]*)/i, combined);
  const priceText = metadata.price ?? (costText ? "" : pick(/(?:price\s*(?:is|:|-)?\s*)?(?:₹|rs\.?|inr)\s*([0-9][0-9,.]*)/i, combined));
  const sizesText = metadata.sizes ?? pick(/sizes?\s*(?:are|:|-)?\s*([a-z0-9, /-]+)/i, combined);
  const colorsText = metadata.colors ?? metadata.colorway ?? pick(/colou?r\s*(?:is|:|-)?\s*([a-z ,/-]+)/i, combined);
  const list = value => Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value).split(/[,/]|\band\b/i).map(clean).filter(Boolean);
  const price = Number(String(priceText || "").replace(/[^0-9.]/g, "")) || null;
  const cost = Number(String(costText || "").replace(/[^0-9.]/g, "")) || null;
  return {
    productName,
    brand: clean(metadata.brand),
    category: clean(metadata.category),
    model: clean(metadata.model || metadata.sku),
    price,
    cost,
    sku: clean(metadata.sku),
    features: list(metadata.features),
    colors: list(colorsText),
    sizes: list(sizesText),
    creativeDirection: clean(metadata.creativeDirection || metadata.tone),
    audience: clean(metadata.audience),
    callToAction: clean(metadata.callToAction),
    sourceText: combined
  };
}

export function buildClarifications({ facts, media, targetChannels = [] }) {
  const questions = [];
  if (!facts.productName || facts.productName.length < 3) {
    questions.push({ id: crypto.randomUUID(), field: "productName", question: "What is the exact product name?", choices: [] });
  }
  if (targetChannels.includes("shopify") && !(Number(facts.cost) > 0)) {
    questions.push({
      id: crypto.randomUUID(),
      field: "cost",
      question: "What is the product cost in INR? Shopify will calculate the selling price automatically from this cost.",
      choices: []
    });
  }
  const uncertainImages = media.filter(item => item.mediaType === "image" && item.role === "UNCERTAIN");
  if (uncertainImages.length) {
    questions.push({
      id: crypto.randomUUID(),
      field: "imageRoles",
      question: uncertainImages.length === 1
        ? `Is ${uncertainImages[0].filename} the product photo or a design reference?`
        : `Which of the ${uncertainImages.length} unlabelled images are product photos, and which are only design references?`,
      choices: [
        { id: "product", label: "Product photo" },
        { id: "reference", label: "Design reference" }
      ],
      assetIds: uncertainImages.map(item => item.assetId)
    });
  }
  const audioWithoutTranscript = media.filter(item => item.mediaType === "audio" && !item.transcript);
  if (audioWithoutTranscript.length) {
    questions.push({
      id: crypto.randomUUID(),
      field: "audioTranscript",
      question: "The voice note was received, but local transcription is not configured. Please send its transcript or the main product details as text.",
      choices: [],
      assetIds: audioWithoutTranscript.map(item => item.assetId)
    });
  }
  return questions;
}

export function toLegacyBrief(facts) {
  return {
    product: facts.productName,
    brand: facts.brand,
    model: facts.model,
    category: facts.category,
    colorway: facts.colors.join(" / "),
    audience: facts.audience || "style-conscious shoppers",
    tone: facts.creativeDirection || "premium, editorial, confident",
    features: facts.features,
    callToAction: facts.callToAction || "Discover the details"
  };
}
