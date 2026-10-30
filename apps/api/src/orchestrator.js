import { buildQueries, buildScenePrompts, buildSceneQueries, productIdentity, validateBrief } from "./brief.js";
import { config } from "./config.js";
import { createDeterministicPlan, normalizePlan, scoreCandidates } from "./planner.js";
import { generateCloudflareBackgrounds, generateGeminiVisionPlan, researchProduct, searchPixabayImages, searchProductImages } from "./providers.js";
import { getMediaRecord, storeMedia } from "./media-store.js";
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
