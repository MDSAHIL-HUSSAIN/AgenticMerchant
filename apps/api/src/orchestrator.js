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
  const queries = buildQueries(brief);
  const warnings = [];
  const suppliedAssets = (options.productAssetIds || []).map(assetId => {
    const record = getMediaRecord(assetId);
    return record ? { assetId, title: record.filename, source: "Merchant upload", width: 0, height: 0, score: 100 } : null;
  }).filter(Boolean);
  let candidates = suppliedAssets;
  let research = [];
  let vision = null;

  if (!config.demoMode && !suppliedAssets.length) {
    const discovery = await Promise.allSettled([
      searchProductImages(queries),
      researchProduct(`${productIdentity(brief)} official product features`)
    ]);
    if (discovery[0].status === "fulfilled") candidates = discovery[0].value;
    else warnings.push(`Product discovery failed: ${discovery[0].reason.message}`);
    if (discovery[1].status === "fulfilled") research = discovery[1].value;
    else warnings.push(`Product research failed: ${discovery[1].reason.message}`);
  }

  const ranked = suppliedAssets.length ? suppliedAssets : scoreCandidates(candidates, brief).slice(0, 10);
  let selectedAssets = ranked.slice(0, 3);
  let plan = createDeterministicPlan(brief);

  if (!config.demoMode && config.geminiApiKey && ranked.length && !suppliedAssets.length) {
    try {
      vision = await generateGeminiVisionPlan({ brief, research, candidates: ranked });
      selectedAssets = chooseVisionAssets(ranked, vision?.selectedCandidateIndexes);
      plan = normalizePlan(vision, brief, selectedAssets.length);
    } catch (error) {
      warnings.push(`Vision art director fell back to metadata ranking: ${error.message}`);
    }
  }

  if (!selectedAssets.length) {
    const placeholders = demoAssets(brief);
    selectedAssets = placeholders;
    warnings.push(config.demoMode
      ? "Demo mode is active; using generated product placeholders."
      : "No usable product image was available; generated placeholders were used.");
  }
  plan = normalizePlan({ designs: plan }, brief, selectedAssets.length);

  let generatedBackgrounds = [];
  let stockBackgrounds = [];
  if (!config.demoMode) {
    const backgroundWork = await Promise.allSettled([
      generateCloudflareBackgrounds(buildScenePrompts(brief, vision?.productProfile).slice(0, 2)),
      searchPixabayImages(buildSceneQueries(brief))
    ]);
    if (backgroundWork[0].status === "fulfilled") generatedBackgrounds = backgroundWork[0].value;
    else warnings.push(`Original background generation failed: ${backgroundWork[0].reason.message}`);
    if (backgroundWork[1].status === "fulfilled") stockBackgrounds = backgroundWork[1].value;
    else warnings.push(`Stock background search failed: ${backgroundWork[1].reason.message}`);
  }

  const backgroundAssets = [...generatedBackgrounds, ...stockBackgrounds].slice(0, 3);
  if (!config.demoMode && backgroundAssets.length === 0) {
    warnings.push("No scene backgrounds were available; the agent will use native Adobe geometry.");
  }

  const designs = plan.map((design, index) => ({
    ...design,
    id: design.id || `design_${index + 1}`,
    backgroundIndex: backgroundAssets.length ? index % backgroundAssets.length : -1
  }));
  let rendered = null;
  try {
    rendered = await renderWithQualityLoop({ brief, designs, assets: selectedAssets, backgroundAssets });
  } catch (error) {
    warnings.push(`Autonomous rendering failed: ${error.message}`);
  }
  const previewAssets = [];
  if (rendered) {
    for (let index = 0; index < rendered.buffers.length; index += 1) {
      previewAssets.push(await storeMedia({
        bytes: rendered.buffers[index],
        mimeType: "image/png",
        filename: `${jobId}-preview-${index + 1}.png`,
        kind: "DESIGN_PREVIEW",
        metadata: { designJobId: jobId, designIndex: index, revision: 1 }
      }));
    }
    if (!rendered.qa.passed) warnings.push("One or more designs did not pass every deterministic quality gate.");
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
    warnings
  };
}
