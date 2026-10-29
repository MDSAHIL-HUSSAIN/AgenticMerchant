import { config } from "./config.js";

async function jsonFetch(url, options = {}) {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = (await response.text()).replace(/\s+/g, " ").slice(0, 600);
    throw new Error(`${response.status} ${response.statusText} from ${new URL(url).hostname}${body ? `: ${body}` : ""}`);
  }
  return response.json();
}

export async function searchProductImages(queries) {
  if (!config.serpApiKey) return [];
  const settled = await Promise.allSettled(queries.map(async query => {
    const url = new URL("https://serpapi.com/search.json");
    url.search = new URLSearchParams({ engine: "google_images", q: query, api_key: config.serpApiKey, safe: "active" });
    const data = await jsonFetch(url, { timeoutMs: 45_000 });
    return (data.images_results || []).slice(0, 8).map(item => ({
      url: item.original,
      thumbnail: item.thumbnail,
      title: item.title || "",
      source: item.source || "",
      width: item.original_width || 0,
      height: item.original_height || 0,
      query
    }));
  }));
  const batches = settled.filter(result => result.status === "fulfilled").map(result => result.value);
  if (!batches.length && settled.length) throw settled[0].reason;
  return batches.flat();
}

export async function researchProduct(query) {
  if (!config.tavilyApiKey) return [];
  const data = await jsonFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: config.tavilyApiKey, query, search_depth: "basic", max_results: 5 })
  });
  return (data.results || []).map(result => ({ title: result.title, url: result.url, content: result.content }));
}

export async function generateGeminiPlan(payload) {
  if (!config.geminiApiKey) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const prompt = `You are a senior ecommerce art director. Return only JSON. Create the single strongest ecommerce campaign design from this input. Do not invent factual product specifications. The design needs kind, headline, subheadline, eyebrow, accent, background, textColor, imageIndex (0-2), and layout (hero-left, hero-right, centered, split, detail, closing). Input: ${JSON.stringify(payload)}`;
  const data = await jsonFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.7 }
    })
  });
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function imagePartFromUrl(url, candidateIndex) {
  if (!url) return null;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "DesignAgentVision/0.2" }
  });
  if (!response.ok) throw new Error(`Image ${candidateIndex} returned ${response.status}`);
  const mimeType = (response.headers.get("content-type") || "").split(";")[0];
  if (!mimeType.startsWith("image/")) throw new Error(`Candidate ${candidateIndex} is not an image`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error(`Candidate ${candidateIndex} exceeds the vision limit`);
  return { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } };
}

function geminiEndpoint() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
}

export async function generateGeminiVisionPlan({ brief, research, candidates }) {
  if (!config.geminiApiKey) return null;
  const visualCandidates = candidates.slice(0, 10);
  const loaded = await Promise.allSettled(visualCandidates.map((candidate, index) =>
    imagePartFromUrl(candidate.thumbnail || candidate.url, index)
  ));
  const imageParts = [];
  loaded.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return;
    const candidate = visualCandidates[index];
    imageParts.push({ text: `CANDIDATE ${index}: ${candidate.title || "untitled"} — source ${candidate.source || "unknown"}` });
    imageParts.push(result.value);
  });
  if (!imageParts.length) throw new Error("No candidate product image could be loaded for visual inspection.");

  const prompt = `You are the vision brain and creative director for an autonomous ecommerce design studio.
Inspect every attached candidate image. The product brief is ${JSON.stringify(brief)}.
Research excerpts: ${JSON.stringify(research.slice(0, 5))}.

First reject images that show the wrong brand/model/category/colorway, another type of product, generic stock, a collage of variants, screenshots with large baked-in text, low resolution, or an unusable crop. Choose up to three distinct candidate indexes that confidently show the requested product. Prefer isolated or clean editorial views and useful angle diversity. Return fewer than three—or none—rather than choosing a visually similar substitute when exactness is uncertain.

Then create the single strongest product-specific campaign image. Derive the art direction from the observed product materials, silhouette, colors, audience and visual language—not from a generic template. Copy must be concise and factual. Return JSON only with:
{
  "productProfile": { "observedProduct": "", "confidence": 0-1, "materials": [], "palette": ["#RRGGBB"], "silhouette": "", "audienceSignal": "", "mood": "", "assetNotes": "", "rejectedSummary": "" },
  "selectedCandidateIndexes": [0,1,2],
  "designs": [one complete design object]
}
The design object requires: kind, eyebrow (max 26 chars), headline (max 52 chars), subheadline (max 100 chars), accent, background, textColor, overlayOpacity (0.35-0.82), imageIndex (0-2), imageTreatment (isolated-stage, editorial-card, or full-bleed-crop), motif (none, contour, precision-grid, motion-lines, or material-dots), layout (hero-left, hero-right, split, centered, detail, or closing), and composition with textX, textY, textWidth, headlineSize, productX, productY, productWidth, productHeight. Choose a motif only when justified by the observed product; avoid decorative clichés. Canvas is 1080 square; use a 64px safe margin, keep footer below y=950, and keep text and product boxes separate. Prioritize one decisive, polished composition over variations.`;

  const data = await jsonFetch(geminiEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.65 }
    }),
    timeoutMs: 90_000
  });
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export async function critiqueGeminiDesigns({ brief, designs, previews }) {
  if (!config.geminiApiKey || !Array.isArray(previews) || !previews.length) return null;
  const imageParts = [];
  previews.slice(0, config.designCount).forEach((dataUrl, index) => {
    const match = String(dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!match) return;
    imageParts.push({ text: `RENDERED PAGE ${index + 1}` });
    imageParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
  });
  if (!imageParts.length) throw new Error("No rendered previews were supplied for visual review.");
  const prompt = `Act as a meticulous senior design reviewer. Inspect the rendered ecommerce campaign image for the brief ${JSON.stringify(brief)}. Current editable specification: ${JSON.stringify(designs)}.
Check canvas overflow, clipped text, collisions, weak hierarchy, illegibility, product identity, generic decoration, poor contrast, awkward crops and irrelevant imagery. Revise the specification—not the factual product claims. Maintain a 64px safe margin and keep the footer clear below y=950. Return JSON only: {"summary":"one concise sentence", "scores":{"identity":0-100,"layout":0-100,"readability":0-100,"cohesion":0-100}, "designs":[one complete corrected design object using the same schema]}.`;
  const data = await jsonFetch(geminiEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.25 }
    }),
    timeoutMs: 90_000
  });
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export async function classifyGeminiUploads({ files, text = "", metadata = {} }) {
  if (!config.geminiApiKey || !config.autonomousMediaAnalysis) return null;
  const imageFiles = files.filter(file => String(file.mimetype || "").startsWith("image/")).slice(0, 10);
  if (!imageFiles.length) return null;
  const parts = [{ text: `You are the multimodal intake agent for an ecommerce design system. The merchant message is ${JSON.stringify(text)} and supplied metadata is ${JSON.stringify(metadata)}. Classify each attached image by its actual content, not its filename. Allowed roles: PRIMARY_PRODUCT, PRODUCT_DETAIL, PRODUCT_VARIANT, PACKAGING, BRAND_LOGO, STYLE_REFERENCE, BACKGROUND_REFERENCE, ANNOTATED_FEEDBACK, UNRELATED, UNCERTAIN. Return JSON only: {"images":[{"index":0,"role":"PRIMARY_PRODUCT","confidence":0.0,"description":""}],"visualFacts":{"productName":"","brand":"","category":"","model":"","colors":[],"features":[]},"needsClarification":false}. Use UNCERTAIN rather than guessing.` }];
  imageFiles.forEach((file, index) => {
    parts.push({ text: `IMAGE ${index}: ${file.originalname || "upload"}` });
    parts.push({ inline_data: { mime_type: file.mimetype, data: file.buffer.toString("base64") } });
  });
  const data = await jsonFetch(geminiEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
    }),
    timeoutMs: 90_000
  });
  const result = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return result ? JSON.parse(result) : null;
}

export async function generateGeminiRevisionPlan({ brief, designs, feedback, targetDesignIds, assetCount }) {
  if (!config.geminiApiKey || !config.autonomousRevisionAi) return null;
  const prompt = `You are a precise ecommerce design revision agent. Return JSON only. The product brief is ${JSON.stringify(brief)}. The current design specification is ${JSON.stringify(designs)}. The merchant requested: ${JSON.stringify(feedback)}. Apply changes only to target design IDs ${JSON.stringify(targetDesignIds)} and preserve every unrequested property. Never invent product facts. Available product image indexes are 0 through ${Math.max(0, assetCount - 1)}. Keep all elements within a 1080 square canvas with 64px safe margins and footer below y=950. Return {"summary":"","designs":[one complete specification]}.`;
  const data = await jsonFetch(geminiEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.15 }
    }),
    timeoutMs: 90_000
  });
  const result = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return result ? JSON.parse(result) : null;
}

export async function searchPixabayImages(queries) {
  if (!config.pixabayApiKey) return [];
  const batches = await Promise.all(queries.map(async query => {
    const url = new URL("https://pixabay.com/api/");
    url.search = new URLSearchParams({
      key: config.pixabayApiKey,
      q: query.slice(0, 100),
      image_type: "photo",
      orientation: "horizontal",
      safesearch: "true",
      editors_choice: "true",
      order: "popular",
      min_width: "1200",
      min_height: "800",
      per_page: "6"
    });
    const data = await jsonFetch(url);
    return (data.hits || []).map(item => ({
      url: item.largeImageURL || item.webformatURL,
      thumbnail: item.previewURL || item.webformatURL,
      title: item.tags || "Editorial background",
      source: `Pixabay · ${item.user || "contributor"}`,
      sourceUrl: item.pageURL,
      width: item.imageWidth || item.webformatWidth || 0,
      height: item.imageHeight || item.webformatHeight || 0,
      query,
      kind: "stock-background"
    })).filter(item => item.url);
  }));
  return batches.flat();
}

export async function generateCloudflareBackground(prompt) {
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) return null;
  if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(config.cloudflareImageModel)) {
    throw new Error("CLOUDFLARE_IMAGE_MODEL must be an @cf/author/model identifier.");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/run/${config.cloudflareImageModel}`;
  const data = await jsonFetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.cloudflareApiToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ prompt, steps: 4 }),
    timeoutMs: 60_000
  });
  const image = data.result?.image || data.image;
  if (!image) throw new Error("Cloudflare returned no generated image.");
  return {
    url: `data:image/jpeg;base64,${image}`,
    thumbnail: `data:image/jpeg;base64,${image}`,
    title: "AI-generated campaign background",
    source: "Cloudflare Workers AI · FLUX.1 schnell",
    width: 1024,
    height: 1024,
    kind: "generated-background",
    prompt
  };
}

export async function generateCloudflareBackgrounds(prompts) {
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) return [];
  const settled = await Promise.allSettled(prompts.map(prompt => generateCloudflareBackground(prompt)));
  const errors = settled.filter(result => result.status === "rejected");
  if (errors.length === settled.length) throw errors[0].reason;
  return settled.filter(result => result.status === "fulfilled" && result.value).map(result => result.value);
}

