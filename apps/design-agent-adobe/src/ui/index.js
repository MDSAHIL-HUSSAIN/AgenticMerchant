import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

const API_BASE = localStorage.getItem("designAgentApi") || "http://localhost:8787";
const $ = id => document.getElementById(id);
let sandboxProxy;
let sandboxCapabilities;
let currentJob;
let productBlobs = [];
let backgroundBlobs = [];
let productVisuals = [];
let backgroundVisuals = [];
let previewCanvases = [];
let activeAdobeJob;
let activeAdobePageId;

window.addEventListener("error", event => setStatus(`Panel error: ${event.message}`, true));
window.addEventListener("unhandledrejection", event => setStatus(`Panel error: ${event.reason?.message || event.reason}`, true));

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", isError);
}

function getBrief() {
  return {
    product: $("product").value,
    brand: $("brand").value,
    model: $("model").value,
    category: $("category").value,
    colorway: $("colorway").value,
    tone: $("tone").value,
    features: $("features").value.replace(/\\n/g, "\n").split("\n").map(value => value.trim()).filter(Boolean)
  };
}

function addNotice(message, className = "warning") {
  const notice = document.createElement("div");
  notice.className = className;
  notice.textContent = message;
  $("warnings").append(notice);
}

function showJob(job, canvases = []) {
  $("warnings").replaceChildren();
  (job.warnings || []).forEach(message => addNotice(message));
  if (job.visualAnalysis) {
    const confidence = Math.round(Number(job.visualAnalysis.confidence || 0) * 100);
    addNotice(`Vision: ${job.visualAnalysis.observedProduct || "product inspected"} · ${confidence}% identity confidence · ${job.visualAnalysis.mood || "art direction derived"}`, "insight");
  }
  if (job.visualReview?.summary) {
    const scores = Object.entries(job.visualReview.scores || {}).map(([name, value]) => `${name} ${value}`).join(" · ");
    addNotice(`Visual QA: ${job.visualReview.summary}${scores ? ` · ${scores}` : ""}`, "insight");
  }

  $("gallery").replaceChildren(...job.designs.map((design, index) => {
    const card = document.createElement("article");
    card.className = "card";
    if (canvases[index]) card.append(canvases[index]);
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = `${index + 1} · ${design.eyebrow}`;
    card.append(caption);
    return card;
  }));
  $("result").hidden = false;
  $("createInAdobe").disabled = false;
}

async function normalizeAssetBlob(input) {
  const decoded = await decodeBlob(input);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(decoded.width, decoded.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  canvas.getContext("2d").drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
  decoded.dispose();
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image conversion failed")), "image/png"));
}

async function fetchAsset(asset) {
  if (asset?.assetId) {
    const response = await fetch(`${API_BASE}/api/assets/${encodeURIComponent(asset.assetId)}/content`);
    if (!response.ok) throw new Error(`Private asset download returned ${response.status}`);
    return normalizeAssetBlob(await response.blob());
  }
  const sources = [asset.url, asset.thumbnail].filter((value, index, values) => value && values.indexOf(value) === index);
  let lastError;
  for (const value of sources) {
    try {
      const source = new URL(value);
      const direct = source.protocol === "data:" || ["localhost", "127.0.0.1"].includes(source.hostname);
      const url = direct ? source : `${API_BASE}/api/image?url=${encodeURIComponent(source.href)}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download returned ${response.status}`);
      return await normalizeAssetBlob(await response.blob());
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not download ${asset.title || "an image"}: ${lastError?.message || "no usable URL"}`);
}

async function decodeBlob(blob) {
  if (!blob.type.includes("svg")) {
    try {
      const bitmap = await createImageBitmap(blob);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } catch (error) {
      console.warn("Bitmap decoding failed; trying HTML image decoding", error);
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`The ${blob.type || "image"} asset could not be decoded`));
      image.src = objectUrl;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || "#000000").replace("#", "");
  const value = Number.parseInt(clean.length === 3 ? clean.split("").map(char => char + char).join("") : clean, 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function drawCover(ctx, visual, x, y, width, height) {
  if (!visual) return;
  const scale = Math.max(width / visual.width, height / visual.height);
  const drawWidth = visual.width * scale;
  const drawHeight = visual.height * scale;
  ctx.drawImage(visual.image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawContain(ctx, visual, box) {
  const scale = Math.min(box.productWidth / visual.width, box.productHeight / visual.height);
  const width = visual.width * scale;
  const height = visual.height * scale;
  const x = box.productX + (box.productWidth - width) / 2;
  const y = box.productY + (box.productHeight - height) / 2;
  ctx.drawImage(visual.image, x, y, width, height);
}

function wrappedLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ") !== lines.join(" ")) lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.…]+$/, "")}…`;
  return lines;
}

function drawMotif(ctx, design) {
  ctx.fillStyle = hexToRgba(design.accent, 0.16);
  ctx.strokeStyle = hexToRgba(design.accent, 0.14);
  ctx.lineWidth = 3;
  if (design.motif === "contour") {
    ctx.beginPath();
    ctx.arc(925, 240, 150, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(925, 240, 105, 0, Math.PI * 2);
    ctx.stroke();
  } else if (design.motif === "motion-lines") {
    for (let row = 0; row < 5; row += 1) ctx.fillRect(65, 815 + row * 19, 250 + row * 70, 3);
  } else if (design.motif === "precision-grid") {
    for (let row = 0; row < 5; row += 1) {
      ctx.fillRect(830 + row * 28, 70, 2, 210);
      ctx.fillRect(780, 95 + row * 28, 210, 2);
    }
  } else if (design.motif === "material-dots") {
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        ctx.beginPath();
        ctx.arc(826 + column * 42, 761 + row * 42, 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawPreview(job, design, index) {
  const canvas = document.createElement("canvas");
  canvas.width = 540;
  canvas.height = 540;
  const ctx = canvas.getContext("2d");
  ctx.scale(0.5, 0.5);
  ctx.fillStyle = design.background;
  ctx.fillRect(0, 0, 1080, 1080);
  const background = backgroundVisuals.length && design.backgroundIndex >= 0
    ? backgroundVisuals[design.backgroundIndex % backgroundVisuals.length]
    : null;
  drawCover(ctx, background, 0, 0, 1080, 1080);
  ctx.fillStyle = hexToRgba(design.background, design.overlayOpacity);
  ctx.fillRect(0, 0, 1080, 1080);
  drawMotif(ctx, design);

  const box = design.composition;
  const product = productVisuals[design.imageIndex % productVisuals.length];
  if (design.imageTreatment === "editorial-card") {
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.fillRect(box.productX + 16, box.productY + 18, box.productWidth, box.productHeight);
    ctx.fillStyle = "rgba(255,255,255,.94)";
    ctx.fillRect(box.productX, box.productY, box.productWidth, box.productHeight);
  } else if (design.imageTreatment === "isolated-stage") {
    ctx.fillStyle = hexToRgba(design.accent, 0.18);
    ctx.beginPath();
    ctx.ellipse(box.productX + box.productWidth / 2, box.productY + box.productHeight * 0.78, box.productWidth * 0.46, 54, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  drawContain(ctx, product, box);

  ctx.textBaseline = "top";
  ctx.fillStyle = design.accent;
  ctx.font = "700 22px Arial";
  ctx.fillText(String(design.eyebrow || "").toUpperCase(), box.textX, box.textY);
  ctx.fillStyle = design.textColor;
  ctx.font = `700 ${box.headlineSize}px Arial`;
  const headlineLines = wrappedLines(ctx, design.headline, box.textWidth, 3);
  headlineLines.forEach((line, lineIndex) => ctx.fillText(line, box.textX, box.textY + 48 + lineIndex * box.headlineSize * 0.94));
  const subY = Math.min(870, box.textY + 70 + headlineLines.length * box.headlineSize * 0.94);
  ctx.font = "400 24px Arial";
  wrappedLines(ctx, design.subheadline, box.textWidth, 3).forEach((line, lineIndex) => ctx.fillText(line, box.textX, subY + lineIndex * 31));

  ctx.fillStyle = hexToRgba(design.textColor, 0.32);
  ctx.fillRect(64, 982, 952, 2);
  ctx.fillStyle = design.textColor;
  ctx.font = "700 16px Arial";
  ctx.fillText(String(index + 1).padStart(2, "0"), 64, 1005);
  ctx.textAlign = "right";
  ctx.fillText("VISION-DIRECTED PRODUCT SERIES", 1016, 1005);
  ctx.textAlign = "left";
  return canvas;
}

function renderPreviews(job) {
  return job.designs.map((design, index) => drawPreview(job, design, index));
}

async function prepareAssets(job) {
  productBlobs = await Promise.all(job.assets.map(fetchAsset));
  const backgroundResults = await Promise.allSettled((job.backgroundAssets || []).map(fetchAsset));
  backgroundBlobs = backgroundResults.filter(result => result.status === "fulfilled").map(result => result.value);
  productVisuals = await Promise.all(productBlobs.map(decodeBlob));
  backgroundVisuals = await Promise.all(backgroundBlobs.map(decodeBlob));
  if (backgroundBlobs.length !== (job.backgroundAssets || []).length) {
    job.warnings.push("One scene asset could not be downloaded; native color treatment replaced it.");
    job.designs.forEach(design => {
      design.backgroundIndex = backgroundBlobs.length ? design.backgroundIndex % backgroundBlobs.length : -1;
    });
  }
}

async function runVisualReview(job, previews) {
  if (!job.agentic?.visualReviewEnabled) return job;
  const response = await fetch(`${API_BASE}/api/critique`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      brief: job.brief,
      designs: job.designs,
      previews
    })
  });
  const review = await response.json();
  if (!response.ok) throw new Error(review.error || "Visual review failed");
  return { ...job, designs: review.designs, visualReview: { summary: review.summary, scores: review.scores } };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read Adobe rendition"));
    reader.readAsDataURL(blob);
  });
}

addOnUISdk.ready.then(async () => {
  sandboxProxy = await addOnUISdk.instance.runtime.apiProxy("documentSandbox");
  if (typeof sandboxProxy.ready !== "function" || !await sandboxProxy.ready()) throw new Error("Adobe document sandbox did not initialize. Refresh the local add-on.");
  sandboxCapabilities = typeof sandboxProxy.capabilities === "function" ? await sandboxProxy.capabilities() : { capabilitiesEndpoint: false };
  console.info("Adobe document sandbox capabilities", JSON.stringify(sandboxCapabilities));
  try {
    const health = await fetch(`${API_BASE}/health`).then(response => response.json());
    setStatus(`API ready · ${health.providers.mode} mode · vision pipeline`);
  } catch {
    setStatus("API offline. Start it with npm run dev:api", true);
  }

  const generatePack = async event => {
    event?.preventDefault();
    const button = $("generate");
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Directing…";
    $("result").hidden = true;
    setStatus("Researching and visually inspecting product candidates…");
    try {
      const response = await fetch(`${API_BASE}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(getBrief())
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Design generation failed");
      currentJob = data;
      setStatus("Preparing selected product views and scene assets…");
      await prepareAssets(currentJob);
      previewCanvases = renderPreviews(currentJob);
      showJob(currentJob, previewCanvases);
      setStatus("Vision-selected pack ready. Transfer it to Adobe for canvas-level visual review and repair.");
    } catch (error) {
      console.error("Design generation failed", error);
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  };

  $("generate").addEventListener("click", generatePack);
  $("briefForm").addEventListener("submit", generatePack);

  $("createInAdobe").addEventListener("click", async () => {
    if (!currentJob) return;
    $("createInAdobe").disabled = true;
    try {
      setStatus("Transferring the reviewed editable system into Adobe Express…");
      if (typeof sandboxProxy.renderPack !== "function") throw new Error("Adobe document renderer is unavailable. Refresh the local add-on and try again.");
      const firstPass = await sandboxProxy.renderPack(currentJob.designs, productBlobs, backgroundBlobs);
      if (!currentJob.agentic?.visualReviewEnabled) {
        setStatus(firstPass.message || "The editable Adobe design was created.");
        return;
      }

      try {
        setStatus("Capturing the actual Adobe pages for autonomous visual QA…");
        const renditions = await addOnUISdk.app.document.createRenditions(
          {
            range: addOnUISdk.constants.Range.specificPages,
            pageIds: firstPass.pageIds,
            format: addOnUISdk.constants.RenditionFormat.jpg,
            quality: 0.72,
            requestedSize: { width: 540, height: 540 }
          },
          addOnUISdk.constants.RenditionIntent.preview
        );
        const actualPreviews = await Promise.all(renditions.map(rendition => blobToDataUrl(rendition.blob)));
        setStatus("Vision critic is inspecting the real Adobe canvas and revising weak pages…");
        currentJob = await runVisualReview(currentJob, actualPreviews);
        previewCanvases = renderPreviews(currentJob);
        showJob(currentJob, previewCanvases);
        const revised = await sandboxProxy.replacePack(currentJob.designs, productBlobs, backgroundBlobs, firstPass.pageIds);
        setStatus(revised.message);
      } catch (error) {
        currentJob.warnings.push(`Canvas-level review could not finish; the safe first pass remains in Adobe: ${error.message}`);
        showJob(currentJob, previewCanvases);
        setStatus("The editable design was created; the optional canvas review did not complete.", true);
      }
    } catch (error) {
      console.error(error);
      const details = sandboxCapabilities ? ` · SDK: ${JSON.stringify(sandboxCapabilities)}` : "";
      setStatus(`${error.message || "Adobe rendering failed"}${details}`, true);
    } finally {
      $("createInAdobe").disabled = false;
    }
  });

  $("loadAdobeEdit").addEventListener("click", async () => {
    const button = $("loadAdobeEdit");
    button.disabled = true;
    try {
      setStatus("Checking the manual-edit queue…");
      const pendingResponse = await fetch(`${API_BASE}/api/adobe/jobs/pending`);
      const pending = await pendingResponse.json();
      if (!pendingResponse.ok) throw new Error(pending.error || "Could not read the Adobe queue");
      if (!pending.jobs?.length) {
        setStatus("No manual Adobe edits are waiting.");
        return;
      }
      activeAdobeJob = pending.jobs[0];
      const claimResponse = await fetch(`${API_BASE}/api/adobe/jobs/${encodeURIComponent(activeAdobeJob.id)}/claim`, { method: "POST" });
      const claimed = await claimResponse.json();
      if (!claimResponse.ok) throw new Error(claimed.error || "Could not claim the Adobe edit");
      activeAdobeJob = claimed;
      setStatus(`Loading ${activeAdobeJob.designId} as native Adobe elements…`);
      const productBlob = await fetchAsset(activeAdobeJob.productAsset);
      const backgroundBlob = activeAdobeJob.backgroundAsset ? await fetchAsset(activeAdobeJob.backgroundAsset).catch(() => undefined) : undefined;
      if (typeof sandboxProxy.renderManualDesign !== "function") throw new Error("Refresh the add-on to load the manual-edit renderer.");
      const result = await sandboxProxy.renderManualDesign(activeAdobeJob.design, productBlob, backgroundBlob);
      activeAdobePageId = result.pageId;
      await fetch(`${API_BASE}/api/adobe/jobs/${encodeURIComponent(activeAdobeJob.id)}/page`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adobePageId: activeAdobePageId })
      });
      $("saveAdobeEdit").disabled = false;
      setStatus(result.message);
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Unable to load the Adobe edit.", true);
    } finally {
      button.disabled = false;
    }
  });

  $("saveAdobeEdit").addEventListener("click", async () => {
    const button = $("saveAdobeEdit");
    button.disabled = true;
    try {
      if (!activeAdobeJob || !activeAdobePageId) throw new Error("Load a pending Adobe edit first.");
      setStatus("Rendering the edited Adobe page…");
      const renditions = await addOnUISdk.app.document.createRenditions(
        {
          range: addOnUISdk.constants.Range.specificPages,
          pageIds: [activeAdobePageId],
          format: addOnUISdk.constants.RenditionFormat.png,
          requestedSize: { width: 1080, height: 1080 }
        },
        addOnUISdk.constants.RenditionIntent.preview
      );
      if (!renditions[0]?.blob) throw new Error("Adobe returned no edited rendition.");
      const form = new FormData();
      form.append("metadata", JSON.stringify({ adobePageId: activeAdobePageId, feedback: "Manual Adobe revision" }));
      form.append("rendition", renditions[0].blob, `${activeAdobeJob.designId}-adobe-edit.png`);
      const response = await fetch(`${API_BASE}/api/adobe/jobs/${encodeURIComponent(activeAdobeJob.id)}/result`, { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the Adobe revision");
      setStatus(`Adobe revision ${result.designJob.revisionNumber} saved and ready for approval.`);
      activeAdobeJob = undefined;
      activeAdobePageId = undefined;
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Unable to save the Adobe revision.", true);
      button.disabled = false;
    }
  });
});
