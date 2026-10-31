import { buildQueries, buildScenePrompts, buildSceneQueries, productIdentity, validateBrief } from "./brief.js";
import { config } from "./config.js";
import { createDeterministicPlan, normalizePlan, scoreCandidates } from "./planner.js";
import { generateCloudflareBackgrounds, generateGeminiVisionPlan, removeProductBackground, researchProduct, searchPixabayImages, searchProductImages } from "./providers.js";
import { getMediaRecord, readMedia, storeMedia } from "./media-store.js";
import { renderWithQualityLoop } from "./quality.js";

function demoAssets(brief) {
  const label = encodeURIComponent(productIdentity(brief));
  return [0, 1, 2].map(index => ({
    url: `http://localhost:${config.port}/api/demo-image/${index}.svg?label=${label}`,
    thumbnail: `http://localhost:${config.port}/api/demo-image/${index}.svg?label=${label}`,
    title: `${productIdentity(brief)} demo angle ${index + 1}`,
    source: "Generated demo placeholder",
    width: 1200,
    height: 1200,
    score: 100 - index
  }));
}

function chooseVisionAssets(ranked, indexes) {
  const selected = [];
  for (const rawIndex of Array.isArray(indexes) ? indexes : []) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || !ranked[index] || selected.includes(ranked[index])) continue;
    selected.push(ranked[index]);
    if (selected.length === 3) break;
  }
  return selected.slice(0, 3);
}

async function loadProductAsset(asset) {
  if (asset.assetId) {
    const stored = await readMedia(asset.assetId);
    return { bytes: stored.bytes, mimeType: stored.record.mimeType, filename: stored.record.filename };
  }
  const url = String(asset.url || asset.thumbnail || "");
  if (!/^https?:\/\//i.test(url)) throw new Error("The selected product image has no downloadable URL.");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "AgenticProductCutout/1.0" }
  });
  if (!response.ok) throw new Error(`Selected product image returned HTTP ${response.status}.`);
  const mimeType = (response.headers.get("content-type") || "").split(";")[0];
  if (!mimeType.startsWith("image/")) throw new Error("The selected product asset is not an image.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 22 * 1024 * 1024) throw new Error("The selected product image exceeds 22 MB.");
  return { bytes, mimeType, filename: `product.${mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg"}` };
}

async function prepareProductCutouts({ assets, designs, jobId, log, warnings }) {
  if (config.demoMode || !config.removeBgApiKey) {
    log("BACKGROUND_REMOVAL", "SKIPPED", config.demoMode
      ? "Product background removal is disabled in demo mode."
      : "REMOVE_BG_API_KEY is not configured; selected product images will retain their original backgrounds.");
    return assets;
  }

  const prepared = [...assets];
  const indexes = [...new Set(designs.map(design => Number(design.imageIndex)).filter(index => Number.isInteger(index) && assets[index]))];
  log("BACKGROUND_REMOVAL", "STARTED", `Removing the background from ${indexes.length} selected product image(s).`, { assetIndexes: indexes });
  let completed = 0;
  for (const index of indexes) {
    try {
      const source = await loadProductAsset(assets[index]);
      const cutout = await removeProductBackground(source);
      const stored = await storeMedia({
        bytes: cutout.bytes,
        mimeType: cutout.mimeType,
        filename: `${jobId}-product-${index + 1}-cutout.png`,
        kind: "PRODUCT_CUTOUT",
        metadata: { designJobId: jobId, sourceAssetIndex: index, backgroundRemoved: true }
      });
      prepared[index] = {
        ...assets[index],
        assetId: stored.id,
        title: `${assets[index].title || "Product image"} — transparent cutout`,
        source: `${assets[index].source || "Product source"} · background removed`,
        backgroundRemoved: true
      };
      completed += 1;
      log("BACKGROUND_REMOVAL", "SUCCESS", `Prepared transparent product cutout ${completed} of ${indexes.length}.`, {
        assetIndex: index,
        assetId: stored.id,
        bytes: stored.byteLength,
        creditsCharged: cutout.creditsCharged
      });
    } catch (error) {
      warnings.push(`Product background removal failed for selected image ${index + 1}: ${error.message}`);
      log("BACKGROUND_REMOVAL", "FAILED", `Could not remove the background from selected product image ${index + 1}; retaining the original.`, {
        assetIndex: index,
        error: error.message
      });
    }
  }
  return prepared;
}

export async function createDesignJob(rawBrief, options = {}) {
  const brief = validateBrief(rawBrief);
  const jobId = crypto.randomUUID();
  const activityLogs = [];
  const log = (stage, status, message, details = null, channel = "image") => {
    const entry = { id: `log_${crypto.randomUUID()}`, sequence: activityLogs.length + 1, at: new Date().toISOString(), stage, status, channel, message, ...(details ? { details } : {}) };
    activityLogs.push(entry);
    console.log(JSON.stringify({ event: "job.activity", jobId, ...entry }));
    options.onActivity?.(entry);
  };
  log("BRIEF_VALIDATED", "SUCCESS", "Validated the product brief for image generation.", { product: brief.product, brand: brief.brand, category: brief.category });
  const queries = buildQueries(brief);
  const warnings = [];
  const suppliedAssets = (options.productAssetIds || []).map(assetId => {
    const record = getMediaRecord(assetId);
    return record ? { assetId, title: record.filename, source: "Merchant upload", width: 0, height: 0, score: 100 } : null;
  }).filter(Boolean);
  log("PRODUCT_MEDIA", suppliedAssets.length ? "SUCCESS" : "INFO", suppliedAssets.length ? `Loaded ${suppliedAssets.length} supplied product image(s).` : "No supplied product image was available; discovery or placeholder fallback may be used.", { suppliedAssetCount: suppliedAssets.length });
  let candidates = suppliedAssets;
  let research = [];
  let vision = null;

  if (!config.demoMode && !suppliedAssets.length) {
    log("PRODUCT_DISCOVERY", "STARTED", "Searching for product imagery and verified product information.", { queryCount: queries.length });
    const discovery = await Promise.allSettled([
      searchProductImages(queries),
      researchProduct(`${productIdentity(brief)} official product features`)
    ]);
    if (discovery[0].status === "fulfilled") {
      candidates = discovery[0].value;
      log("PRODUCT_DISCOVERY", "SUCCESS", `Product image discovery returned ${candidates.length} candidate(s).`);
    } else {
      warnings.push(`Product discovery failed: ${discovery[0].reason.message}`);
      log("PRODUCT_DISCOVERY", "FAILED", "Product image discovery failed.", { error: discovery[0].reason.message });
    }
    if (discovery[1].status === "fulfilled") {
      research = discovery[1].value;
      log("PRODUCT_RESEARCH", "SUCCESS", `Product research returned ${research.length} result(s).`);
    } else {
      warnings.push(`Product research failed: ${discovery[1].reason.message}`);
      log("PRODUCT_RESEARCH", "FAILED", "Product research failed.", { error: discovery[1].reason.message });
    }
  }

  const ranked = suppliedAssets.length ? suppliedAssets : scoreCandidates(candidates, brief).slice(0, 10);
  let selectedAssets = ranked.slice(0, 3);
  let plan = createDeterministicPlan(brief);

  if (!config.demoMode && config.geminiApiKey && ranked.length && !suppliedAssets.length) {
    log("VISION_PLANNING", "STARTED", "Asking the visual director to select product references and art direction.", { candidateCount: ranked.length });
    try {
      vision = await generateGeminiVisionPlan({ brief, research, candidates: ranked });
      selectedAssets = chooseVisionAssets(ranked, vision?.selectedCandidateIndexes);
      plan = normalizePlan(vision, brief, selectedAssets.length);
      log("VISION_PLANNING", "SUCCESS", `The visual director selected ${selectedAssets.length} product reference(s).`);
    } catch (error) {
      warnings.push(`Vision art director fell back to metadata ranking: ${error.message}`);
      log("VISION_PLANNING", "WARNING", "Visual direction failed; continuing with deterministic asset ranking.", { error: error.message });
    }
  } else {
    log("VISION_PLANNING", "SKIPPED", suppliedAssets.length ? "Visual reference discovery was skipped because merchant product images were supplied." : "Visual direction is not configured; using the deterministic design planner.");
  }

  if (!selectedAssets.length) {
    const placeholders = demoAssets(brief);
    selectedAssets = placeholders;
    warnings.push(config.demoMode
      ? "Demo mode is active; using generated product placeholders."
      : "No usable product image was available; generated placeholders were used.");
    log("PRODUCT_MEDIA_FALLBACK", "WARNING", "No usable product image was found; generated placeholders were selected.", { placeholderCount: selectedAssets.length });
  }
  log("DESIGN_PLAN", "SUCCESS", `Prepared ${plan.length} image composition(s).`, { selectedAssetCount: selectedAssets.length });
  plan = normalizePlan({ designs: plan }, brief, selectedAssets.length);

  let generatedBackgrounds = [];
  let stockBackgrounds = [];
  if (!config.demoMode) {
    log("BACKGROUND_GENERATION", "STARTED", "Generating original scene backgrounds and searching optional stock backgrounds.");
    const backgroundWork = await Promise.allSettled([
      generateCloudflareBackgrounds(buildScenePrompts(brief, vision?.productProfile).slice(0, 2)),
      searchPixabayImages(buildSceneQueries(brief))
    ]);
    if (backgroundWork[0].status === "fulfilled") {
      generatedBackgrounds = backgroundWork[0].value;
      log("BACKGROUND_GENERATION", "SUCCESS", `Generated ${generatedBackgrounds.length} original background(s).`);
    } else {
      warnings.push(`Original background generation failed: ${backgroundWork[0].reason.message}`);
      log("BACKGROUND_GENERATION", "FAILED", "Original background generation failed.", { error: backgroundWork[0].reason.message });
    }
    if (backgroundWork[1].status === "fulfilled") {
      stockBackgrounds = backgroundWork[1].value;
      log("STOCK_BACKGROUND_SEARCH", "SUCCESS", `Found ${stockBackgrounds.length} stock background candidate(s).`);
    } else {
      warnings.push(`Stock background search failed: ${backgroundWork[1].reason.message}`);
      log("STOCK_BACKGROUND_SEARCH", "FAILED", "Stock background search failed.", { error: backgroundWork[1].reason.message });
    }
  } else {
    log("BACKGROUND_GENERATION", "SKIPPED", "External background generation is disabled in demo mode.");
  }

  const backgroundAssets = [...generatedBackgrounds, ...stockBackgrounds].slice(0, 3);
  if (!config.demoMode && backgroundAssets.length === 0) {
    warnings.push("No scene backgrounds were available; the agent will use native Adobe geometry.");
    log("BACKGROUND_FALLBACK", "WARNING", "No generated or stock background was usable; native design geometry will be used.");
  }

  const designs = plan.map((design, index) => ({
    ...design,
    id: design.id || `design_${index + 1}`,
    backgroundIndex: backgroundAssets.length ? index % backgroundAssets.length : -1
  }));
  selectedAssets = await prepareProductCutouts({ assets: selectedAssets, designs, jobId, log, warnings });
  let rendered = null;
  try {
    log("IMAGE_RENDER", "STARTED", `Rendering ${designs.length} final image composition(s) and running quality checks.`);
    rendered = await renderWithQualityLoop({ brief, designs, assets: selectedAssets, backgroundAssets });
    log("IMAGE_RENDER", "SUCCESS", `Rendered ${rendered.buffers.length} image composition(s).`, { qaPassed: rendered.qa.passed, qaScore: rendered.qa.score || null });
  } catch (error) {
    warnings.push(`Autonomous rendering failed: ${error.message}`);
    log("IMAGE_RENDER", "FAILED", "Autonomous image rendering failed.", { error: error.message });
  }
  const previewAssets = [];
  if (rendered) {
    for (let index = 0; index < rendered.buffers.length; index += 1) {
      const stored = await storeMedia({
        bytes: rendered.buffers[index],
        mimeType: "image/png",
        filename: `${jobId}-preview-${index + 1}.png`,
        kind: "DESIGN_PREVIEW",
        metadata: { designJobId: jobId, designIndex: index, revision: 1 }
      });
      previewAssets.push(stored);
      log("IMAGE_STORED", "SUCCESS", `Stored preview image ${index + 1} of ${rendered.buffers.length}.`, { assetId: stored.id, bytes: stored.byteLength });
    }
    if (!rendered.qa.passed) {
      warnings.push("One or more designs did not pass every deterministic quality gate.");
      log("IMAGE_QA", "WARNING", "One or more images need review after deterministic quality checks.", { issues: rendered.qa.issues || [] });
    } else {
      log("IMAGE_QA", "SUCCESS", "All generated images passed deterministic quality checks.");
    }
  }

  return {
    id: jobId,
    createdAt: new Date().toISOString(),
    brief,
    queries,
    assets: selectedAssets,
    backgroundAssets,
    visualAnalysis: vision?.productProfile || null,
    agentic: { visionSelection: Boolean(vision), visualReviewEnabled: Boolean(config.geminiApiKey && !config.demoMode) },
    designs: (rendered?.designs || designs).map((design, index) => ({ ...design, id: design.id || `design_${index + 1}` })),
    previewAssets: previewAssets.map(asset => ({ assetId: asset.id, mimeType: asset.mimeType, byteLength: asset.byteLength, designIndex: asset.designIndex })),
    qa: rendered?.qa || null,
    warnings,
    activityLogs
  };
}
