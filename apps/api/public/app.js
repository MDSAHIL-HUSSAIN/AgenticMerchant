const $ = selector => document.querySelector(selector);
const state = { draft: null, job: null, selected: new Set(), busyTimer: null, outputType: "image" };

const elements = {
  form: $("#brief-form"), modePill: $("#mode-pill"), empty: $("#empty-state"), grid: $("#design-grid"),
  clarification: $("#clarification"), actions: $("#workspace-actions"), revision: $("#revision-label"),
  selectAll: $("#select-all"), dock: $("#review-dock"), selectionCount: $("#selection-count"),
  feedback: $("#feedback-input"), revise: $("#revise-button"), approve: $("#approve-button"),
  exports: $("#exports-section"), exportGallery: $("#exports-gallery"), exportStats: $("#export-stats"),
  activity: $("#activity-log"), loading: $("#loading-screen"), loadingTitle: $("#loading-title"),
  loadingDetail: $("#loading-detail"), toast: $("#toast"), dialog: $("#image-dialog"),
  dialogImage: $("#dialog-image"), dialogLabel: $("#dialog-label"), dialogDownload: $("#dialog-download")
};

function splitList(value) { return String(value || "").split(/\n|,/).map(item => item.trim()).filter(Boolean); }
function assetUrl(assetId) { return `/api/assets/${encodeURIComponent(assetId)}/content`; }
function stamp() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function addActivity(message) {
  const li = document.createElement("li");
  li.innerHTML = `<time>${stamp()}</time><span></span>`;
  li.querySelector("span").textContent = message;
  elements.activity.prepend(li);
}
function toast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.className = "toast", 3500);
}
function busy(title, detail = "The local renderer is composing and inspecting each image.") {
  elements.loadingTitle.textContent = title;
  elements.loadingDetail.textContent = detail;
  elements.loading.hidden = false;
  const stages = ["Reading the product brief…", "Choosing the strongest art direction…", "Composing product and typography…", "Running visual boundary checks…", "Preparing the review board…"];
  let index = Math.max(0, stages.indexOf(title));
  clearInterval(state.busyTimer);
  state.busyTimer = setInterval(() => { index = Math.min(index + 1, stages.length - 1); elements.loadingTitle.textContent = stages[index]; }, 1700);
}
function idle() { clearInterval(state.busyTimer); elements.loading.hidden = true; }

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `Request failed (${response.status})`);
  return body;
}

async function checkHealth() {
  try {
    const health = await api("/health");
    const dot = elements.modePill.querySelector(".status-dot");
    dot.classList.add("online");
    elements.modePill.lastChild.textContent = health.providers.mode === "demo" ? " Local demo engine" : " Live provider mode";
  } catch { elements.modePill.lastChild.textContent = " Engine unavailable"; }
}

function metadataFromForm() {
  const data = new FormData(elements.form);
  state.outputType = data.get("outputType") === "video" ? "video" : "image";
  return {
    merchantId: "demo_merchant",
    conversationId: `demo_${Date.now()}`,
    productName: data.get("productName"), brand: data.get("brand"), category: data.get("category"),
    price: Number(data.get("price")) || null, model: data.get("model"), features: splitList(data.get("features")),
    colors: splitList(data.get("colors")), sizes: splitList(data.get("sizes")),
    creativeDirection: data.get("creativeDirection"), callToAction: data.get("callToAction"),
    mediaRoles: { product_image: "PRIMARY_PRODUCT", reference_image: "STYLE_REFERENCE" }, outputType: state.outputType
  };
}

function inputFiles(inputId, fieldName, targetForm) {
  for (const file of $(inputId).files) targetForm.append(fieldName, file, file.name);
}

async function createDraft(event) {
  event.preventDefault();
  const requestedOutput = new FormData(elements.form).get("outputType");
  if (requestedOutput === "video" && $("#product-files").files.length === 0) {
    toast("A product photo is required for a product film. Choose the image again before generating.", true);
    addActivity("Stopped before upload: no product photo was selected for the video.");
    return;
  }
  state.selected.clear();
  elements.exports.hidden = true;
  busy("Reading the product brief…");
  addActivity("Received a new product brief from the temporary demo interface.");
  try {
    const metadata = metadataFromForm();
    const payload = new FormData();
    payload.append("metadata", JSON.stringify(metadata));
    inputFiles("#product-files", "product_image", payload);
    inputFiles("#reference-files", "reference_image", payload);
    state.draft = await api("/api/product-drafts/messages", { method: "POST", body: payload });
    addActivity(`Draft ${state.draft.id.slice(-8)} assembled with ${state.draft.media.length} media file(s).`);
    if (state.outputType === "video" && !state.draft.media.some(item => item.role === "PRIMARY_PRODUCT")) {
      throw new Error("The backend did not receive a usable product photo. Re-select it and try again; video generation was not started.");
    }
    if (state.draft.status === "NEEDS_CLARIFICATION") {
      idle();
      showClarification();
      return;
    }
    await generateCreative();
  } catch (error) { idle(); toast(error.message, true); addActivity(`Stopped: ${error.message}`); }
}

function showClarification() {
  elements.empty.hidden = true;
  elements.grid.hidden = true;
  const question = state.draft.questions[0];
  elements.clarification.hidden = false;
  elements.clarification.innerHTML = `<h3>The agent needs one answer</h3><p>${question.question}</p><div></div>`;
  const choices = question.choices?.length ? question.choices : [{ id: "answer", label: "Continue", prompt: true }];
  for (const choice of choices) {
    const button = document.createElement("button");
    button.textContent = choice.label;
    button.onclick = async () => {
      const answer = choice.prompt ? window.prompt(question.question) : choice.id;
      if (!answer) return;
      busy("Updating the product brief…");
      try {
        state.draft = await api(`/api/product-drafts/${state.draft.id}/clarifications`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ questionId: question.id, answer }) });
        elements.clarification.hidden = true;
        addActivity(`Clarification recorded: ${answer}.`);
        state.draft.questions.length ? (idle(), showClarification()) : await generateCreative();
      } catch (error) { idle(); toast(error.message, true); }
    };
    elements.clarification.querySelector("div").append(button);
  }
}

async function generateDesigns() {
  elements.loadingTitle.textContent = "Choosing the strongest art direction…";
  state.job = await api(`/api/product-drafts/${state.draft.id}/design`, { method: "POST" });
  idle();
  addActivity(`Rendered the final autonomous design. Quality status: ${state.job.qa?.passed ? "passed" : "review recommended"}.`);
  if (state.job.warnings?.length) state.job.warnings.forEach(warning => addActivity(`Note: ${warning}`));
  renderJob();
  $("#workspace-title").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function generateCreative() {
  if (state.outputType !== "video") return generateDesigns();
  elements.loadingTitle.textContent = "Directing the product film…";
  state.job = await api(`/api/product-drafts/${state.draft.id}/video`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ durationSeconds: 30, aspectRatio: "9:16", fps: 30 })
  });
  addActivity(`Video job ${state.job.id.slice(-8)} entered the local GPU queue.`);
  let lastStage = state.job.progress?.stage || "";
  elements.loadingDetail.textContent = "A 30-second local generative film may take 25–40 minutes on this GPU.";
  while (!["AWAITING_APPROVAL", "FAILED", "CANCELLED"].includes(state.job.status)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    state.job = await api(`/api/video-jobs/${state.job.id}`);
    if (state.job.progress?.message) {
      elements.loadingTitle.textContent = state.job.progress.message;
      const stage = String(state.job.progress.stage || "WORKING").replaceAll("_", " ");
      elements.loadingDetail.textContent = `${stage} · ${state.job.progress.percent || 0}% · Local GPU processing`;
      if (state.job.progress.stage && state.job.progress.stage !== lastStage) {
        addActivity(state.job.progress.message);
        lastStage = state.job.progress.stage;
      }
    }
  }
  if (state.job.status !== "AWAITING_APPROVAL") throw new Error(state.job.error || `Video generation ${state.job.status.toLowerCase()}.`);
  idle();
  state.selected = new Set(["video_master"]);
  addActivity(`The ${state.job.videoSpec.durationSeconds}-second film passed temporal QA with score ${state.job.qa.score}.`);
  renderJob();
  $("#workspace-title").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderJob() {
  elements.empty.hidden = true;
  elements.clarification.hidden = true;
  elements.grid.hidden = false;
  elements.actions.hidden = false;
  elements.dock.hidden = false;
  elements.revision.textContent = `REVISION ${String(state.job.revisionNumber).padStart(2,"0")}`;
  elements.grid.innerHTML = "";
  if (state.job.type === "VIDEO_POST") {
    const preview = state.job.previewAssets.find(item => item.mimeType === "video/mp4");
    const card = document.createElement("article");
    card.className = "design-card selected video-card";
    card.dataset.id = "video_master";
    card.innerHTML = `<div class="design-image-wrap"><video src="${assetUrl(preview.assetId)}" controls playsinline preload="metadata"></video></div><div class="design-card-meta"><div><span>01 · AUTONOMOUS FILM</span><b>${escapeHtml(state.job.creativeTreatment.title)}</b></div><a class="zoom-button" href="${assetUrl(preview.assetId)}" download="product-film.mp4" aria-label="Download preview">↓</a></div>`;
    elements.grid.append(card);
    updateSelection();
    return;
  }
  state.job.designs.forEach((design, index) => {
    const preview = state.job.previewAssets.find(item => Number(item.designIndex) === index);
    if (!preview) return;
    const url = assetUrl(preview.assetId);
    const card = document.createElement("article");
    card.className = `design-card${state.selected.has(design.id) ? " selected" : ""}`;
    card.dataset.id = design.id;
    card.innerHTML = `<div class="design-image-wrap"><img src="${url}" alt="${escapeHtml(design.kind)} design preview ${index + 1}"></div><div class="design-card-meta"><div><span>0${index + 1} · ${escapeHtml(design.kind)}</span><b>${escapeHtml(design.headline)}</b></div><button class="zoom-button" type="button" aria-label="View full size">↗</button></div>`;
    card.addEventListener("click", event => {
      if (event.target.closest(".zoom-button")) return openImage(url, `${index + 1} · ${design.kind}`, `${design.id}.png`);
      state.selected.has(design.id) ? state.selected.delete(design.id) : state.selected.add(design.id);
      updateSelection();
    });
    elements.grid.append(card);
  });
  updateSelection();
}

function updateSelection() {
  document.querySelectorAll(".design-card").forEach(card => card.classList.toggle("selected", state.selected.has(card.dataset.id)));
  elements.selectionCount.textContent = `${state.selected.size} selected`;
  elements.approve.disabled = state.selected.size === 0;
  elements.revise.disabled = state.selected.size === 0;
  const total = state.job?.type === "VIDEO_POST" ? 1 : (state.job?.designs?.length || 0);
  elements.selectAll.textContent = state.selected.size === total ? "Clear all" : "Select all";
}

function openImage(url, label, filename) {
  elements.dialogImage.src = url;
  elements.dialogLabel.textContent = label;
  elements.dialogDownload.href = url;
  elements.dialogDownload.download = filename;
  elements.dialog.showModal();
}

async function revise() {
  if (!state.selected.size) return toast("Select at least one design.", true);
  const feedback = elements.feedback.value.trim();
  if (!feedback) return toast("Write the change you want the agent to apply.", true);
  busy("Recomposing the selected designs…", "The request is applied locally, then every changed design is checked again.");
  try {
    state.job = await api(`/api/jobs/${state.job.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "EDIT_SELECTED", designIds: [...state.selected], feedback, idempotencyKey: `demo-edit-${Date.now()}` })
    });
    if (state.job.type === "VIDEO_POST") {
      while (!["AWAITING_APPROVAL", "FAILED", "CANCELLED"].includes(state.job.status)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        state.job = await api(`/api/video-jobs/${state.job.id}`);
      }
      if (state.job.status !== "AWAITING_APPROVAL") throw new Error(state.job.error || "Video revision failed.");
    }
    idle();
    elements.feedback.value = "";
    addActivity(`Created revision ${state.job.revisionNumber}: “${feedback}”`);
    renderJob();
    toast(`Revision ${state.job.revisionNumber} is ready.`);
  } catch (error) { idle(); toast(error.message, true); addActivity(`Revision failed: ${error.message}`); }
}

async function approve() {
  if (!state.selected.size) return toast("Select at least one design.", true);
  busy("Exporting approved artwork…", "Creating Shopify, Instagram and Facebook files from the selected design(s).");
  try {
    state.job = await api(`/api/jobs/${state.job.id}/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ designIds: [...state.selected], idempotencyKey: `demo-approve-${Date.now()}` })
    });
    idle();
    addActivity(`Approved ${state.job.approvedDesignIds.length} design(s) and generated ${state.job.finalAssets.length} final files.`);
    const publishing = [...(state.job.handoffs || [])].reverse().find(item => item.type === "PUBLISHING");
    if (publishing?.status === "DELIVERED") addActivity("Approved assets were sent to the configured publishing services automatically.");
    renderExports();
    toast("Approved files are ready to inspect and download.");
    elements.exports.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { idle(); toast(error.message, true); addActivity(`Export failed: ${error.message}`); }
}

function renderExports() {
  const assets = state.job.finalAssets;
  elements.exports.hidden = false;
  const video = state.job.type === "VIDEO_POST";
  elements.exportStats.innerHTML = `<div class="export-stat"><b>${assets.length}</b><span>${video ? "Delivery files" : "PNG files"}</span></div><div class="export-stat"><b>${state.job.approvedDesignIds.length}</b><span>Approved creative</span></div><div class="export-stat"><b>${video ? 5 : 5}</b><span>Platform formats</span></div>`;
  elements.exportGallery.innerHTML = "";
  assets.forEach((asset, index) => {
    const url = assetUrl(asset.assetId);
    const card = document.createElement("article");
    card.className = `export-card${index === 0 ? " hero-export" : ""}`;
    const media = video && asset.mimeType === "video/mp4" ? `<video src="${url}" controls playsinline preload="metadata"></video>` : `<img src="${url}" alt="${escapeHtml(asset.platform)} final export">`;
    const extension = asset.mimeType === "video/mp4" ? "mp4" : "png";
    card.innerHTML = `${media}<div><span>${escapeHtml(asset.platform)} · ${asset.width}×${asset.height}</span><a href="${url}" download="${asset.platform}.${extension}">↓ ${extension.toUpperCase()}</a></div>`;
    if (!video || asset.mimeType !== "video/mp4") card.querySelector("img").onclick = () => openImage(url, `${asset.platform} · ${asset.width}×${asset.height}`, `${asset.platform}.${extension}`);
    elements.exportGallery.append(card);
  });
}

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value || ""); return node.innerHTML; }
function bindFileCount(input, output) {
  $(input).addEventListener("change", event => { const files = [...event.target.files]; $(output).textContent = files.length ? `${files.length} · ${files.map(file => file.name).join(", ")}` : "No files selected"; });
}

elements.form.addEventListener("submit", createDraft);
elements.selectAll.addEventListener("click", () => {
  if (state.job.type === "VIDEO_POST") state.selected.size ? state.selected.clear() : state.selected.add("video_master");
  else state.selected.size === state.job.designs.length ? state.selected.clear() : state.job.designs.forEach(design => state.selected.add(design.id));
  updateSelection();
});
elements.revise.addEventListener("click", revise);
elements.approve.addEventListener("click", approve);
$(".dialog-close").addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", event => { if (event.target === elements.dialog) elements.dialog.close(); });
bindFileCount("#product-files", "#product-file-count");
bindFileCount("#reference-files", "#reference-file-count");
checkHealth();
