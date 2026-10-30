import sharp from "sharp";
import { config } from "./config.js";
import { readMedia, storeMedia } from "./media-store.js";
import { generateCloudflareBackground } from "./providers.js";

const xml = value => String(value || "").replace(/[<>&\"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" }[character]));

function wrapHeadline(value, maxCharacters = 23) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const candidate = [lines.at(-1), word].filter(Boolean).join(" ");
    if (!lines.length || candidate.length > maxCharacters) lines.push(word);
    else lines[lines.length - 1] = candidate;
  }
  if (lines.length > 2) return [`${lines[0]} ${lines[1]}`.slice(0, maxCharacters), `${lines.slice(2).join(" ")}`.slice(0, maxCharacters)];
  return lines.slice(0, 2);
}

async function productLayer(assetId, width, height, accent, fit = "contain", focus = { x: .5, y: .5, zoom: 1 }) {
  if (assetId) {
    try {
      const { bytes } = await readMedia(assetId);
      let pipeline = sharp(bytes);
      const metadata = await pipeline.metadata();
      const zoom = Math.max(1, Math.min(4, Number(focus?.zoom) || 1));
      if (zoom > 1.01 && metadata.width && metadata.height) {
        const targetAspect = width / height;
        let cropWidth = Math.max(1, Math.round(metadata.width / zoom));
        let cropHeight = Math.max(1, Math.round(cropWidth / targetAspect));
        if (cropHeight > metadata.height) {
          cropHeight = Math.max(1, Math.round(metadata.height / zoom));
          cropWidth = Math.max(1, Math.round(cropHeight * targetAspect));
        }
        cropWidth = Math.min(cropWidth, metadata.width);
        cropHeight = Math.min(cropHeight, metadata.height);
        const focusX = Number.isFinite(Number(focus?.x)) ? Number(focus.x) : .5;
        const focusY = Number.isFinite(Number(focus?.y)) ? Number(focus.y) : .5;
        const centerX = focusX * metadata.width;
        const centerY = focusY * metadata.height;
        const left = Math.max(0, Math.min(metadata.width - cropWidth, Math.round(centerX - cropWidth / 2)));
        const top = Math.max(0, Math.min(metadata.height - cropHeight, Math.round(centerY - cropHeight / 2)));
        pipeline = pipeline.extract({ left, top, width: cropWidth, height: cropHeight });
      }
      return await pipeline.resize(width, height, { fit, position: "centre", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    } catch { /* deterministic placeholder below */ }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#151517"/><stop offset=".55" stop-color="${accent}"/><stop offset="1" stop-color="#08080A"/></linearGradient></defs><ellipse cx="${width / 2}" cy="${height * .84}" rx="${width * .38}" ry="${height * .055}" fill="#000" opacity=".3"/><path d="M${width * .16} ${height * .58} C${width * .28} ${height * .24},${width * .61} ${height * .12},${width * .82} ${height * .38} L${width * .88} ${height * .65} C${width * .72} ${height * .76},${width * .35} ${height * .8},${width * .13} ${height * .7}Z" fill="url(#p)"/><path d="M${width * .2} ${height * .66} L${width * .84} ${height * .55}" stroke="#fff" stroke-width="${Math.max(4, width * .018)}" opacity=".75"/></svg>`;
  return Buffer.from(svg);
}

async function removeConnectedWhiteBackground(bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  const connected = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let head = 0;
  let tail = 0;
  const isWhite = pixel => {
    const offset = pixel * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    return red >= 195 && green >= 195 && blue >= 195 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 36;
  };
  const add = pixel => {
    if (pixel < 0 || pixel >= pixels || connected[pixel] || !isWhite(pixel)) return;
    connected[pixel] = 1;
    queue[tail++] = pixel;
  };
  for (let x = 0; x < info.width; x += 1) {
    add(x);
    add((info.height - 1) * info.width + x);
  }
  for (let y = 0; y < info.height; y += 1) {
    add(y * info.width);
    add(y * info.width + info.width - 1);
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % info.width;
    if (x > 0) add(pixel - 1);
    if (x + 1 < info.width) add(pixel + 1);
    if (pixel >= info.width) add(pixel - info.width);
    if (pixel + info.width < pixels) add(pixel + info.width);
  }
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (connected[pixel]) data[pixel * 4 + 3] = 0;
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

async function rigidProductPlate(assetId, width, height, background, accent, style, shot, shotIndex) {
  const { bytes } = await readMedia(assetId);
  const cutout = await removeConnectedWhiteBackground(bytes);
  const stageSpec = shot.stage || {};
  const productScale = Math.max(.65, Math.min(1.5, Number(stageSpec.productScale) || 1));
  const productWidth = Math.round(width * Math.min(.98, .82 * productScale));
  const productHeight = Math.round(height * Math.min(.70, .50 * productScale));
  const rotation = Math.max(-8, Math.min(8, Number(stageSpec.rotationDegrees) || 0));
  const product = await sharp(cutout)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(productWidth, productHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize({ width: Math.round(width * .98), height: Math.round(height * .72), fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const productMetadata = await sharp(product).metadata();
  const renderedWidth = productMetadata.width || productWidth;
  const renderedHeight = productMetadata.height || productHeight;
  const productX = Math.max(.1, Math.min(.9, Number(stageSpec.productX) || .5));
  const productY = Math.max(.15, Math.min(.82, Number(stageSpec.productY) || .49));
  const left = Math.max(0, Math.min(width - renderedWidth, Math.round(productX * width - renderedWidth / 2)));
  const top = Math.max(0, Math.min(height - renderedHeight, Math.round(productY * height - renderedHeight / 2)));
  const backgroundStyle = String(stageSpec.backgroundStyle || "STUDIO_VOID").toUpperCase();
  const grid = `<pattern id="grid" width="${Math.round(width * .08)}" height="${Math.round(width * .08)}" patternUnits="userSpaceOnUse"><path d="M ${Math.round(width * .08)} 0 L 0 0 0 ${Math.round(width * .08)}" fill="none" stroke="${accent}" stroke-opacity=".12" stroke-width="1"/></pattern>`;
  const treatments = {
    ARCHITECTURAL_GRID: `<rect width="${width}" height="${height}" fill="url(#grid)"/><path d="M0 ${height * .72}L${width} ${height * .55}M0 ${height * .86}L${width} ${height * .63}" stroke="${accent}" stroke-opacity=".20"/>`,
    LIGHT_TUNNEL: `<g fill="none" stroke="${accent}" stroke-opacity=".20">${[.92, .72, .54, .38].map(size => `<rect x="${width * (1 - size) / 2}" y="${height * (1 - size) / 2}" width="${width * size}" height="${height * size}" rx="${width * .06}"/>`).join("")}</g>`,
    SOFT_HALO: `<ellipse cx="${width * productX}" cy="${height * productY}" rx="${width * .43}" ry="${height * .29}" fill="${accent}" opacity=".17"/>`,
    NEON_GRADIENT: `<path d="M${-width * .1} ${height * .72}L${width * 1.1} ${height * .22}" stroke="#6C38FF" stroke-width="${width * .13}" stroke-opacity=".13"/><path d="M${-width * .1} ${height * .82}L${width * 1.1} ${height * .38}" stroke="${accent}" stroke-width="${width * .025}" stroke-opacity=".28"/>`,
    MONOCHROME: `<rect width="${width}" height="${height}" fill="#D8DAE0" opacity=".72"/><ellipse cx="${width * .5}" cy="${height * .42}" rx="${width * .48}" ry="${height * .34}" fill="#FFFFFF" opacity=".18"/>`,
    MACRO_SURFACE: `<path d="M0 ${height * .64} Q${width * .5} ${height * .54} ${width} ${height * .66}V${height}H0Z" fill="${accent}" opacity=".09"/><path d="M0 ${height * .64} Q${width * .5} ${height * .54} ${width} ${height * .66}" stroke="${accent}" stroke-opacity=".28"/>`,
    STUDIO_VOID: ""
  };
  const stage = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="studio" x1="${shotIndex % 2}" y1="0" x2="${(shotIndex + 1) % 2}" y2="1"><stop stop-color="#03040A"/><stop offset=".48" stop-color="${background}"/><stop offset="1" stop-color="#09031A"/></linearGradient>
      <radialGradient id="rgb" cx="${style.glowX}" cy="${style.glowY}" r="72%"><stop stop-color="${accent}" stop-opacity=".58"/><stop offset=".48" stop-color="#5B2EFF" stop-opacity=".20"/><stop offset="1" stop-color="#02030A" stop-opacity="0"/></radialGradient>
      <radialGradient id="floor" cx="50%" cy="50%" r="50%"><stop stop-color="${accent}" stop-opacity=".30"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
      ${grid}
    </defs>
    <rect width="${width}" height="${height}" fill="url(#studio)"/><rect width="${width}" height="${height}" fill="url(#rgb)"/>
    ${treatments[backgroundStyle] || ""}
    <ellipse cx="${width * productX}" cy="${Math.min(height * .82, top + renderedHeight * .92)}" rx="${Math.min(width * .46, renderedWidth * .48)}" ry="${height * .055}" fill="url(#floor)"/>
  </svg>`;
  return sharp(Buffer.from(stage)).composite([{
    input: product,
    left,
    top
  }]).png().toBuffer();
}

async function peopleSceneFrame(shot, brief, width, height) {
  const identity = [brief.brand, brief.product, brief.category].filter(Boolean).join(" ");
  const prompt = `${shot.prompt} Story frame for ${identity}. Photorealistic editorial cinematography, one clear human action, expressive but natural body language, realistic anatomy and hands, rich environmental depth, premium practical lighting, vertical 9:16 framing, no typography, no captions, no watermark, no logo.`;
  const generated = await generateCloudflareBackground(prompt);
  const match = generated?.url?.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match) throw new Error(`The people-scene image generator returned no usable frame for ${shot.id}.`);
  return sharp(Buffer.from(match[1], "base64"))
    .resize(width, height, { fit: "cover", position: "attention" })
    .modulate({ saturation: 0.92 })
    .png()
    .toBuffer();
}

export async function renderVideoKeyframes({ jobId, brief, plan, productAssetIds = [], existingKeyframes = [], onlyShotIds = [] }) {
  // These are master plates. Preview rendering may scale them down, while the
  // approved timeline reuses them at native delivery resolution.
  const width = config.videoFinalWidth;
  const height = config.videoFinalHeight;
  const [background, textColor, accent = "#B8C2CF"] = plan.palette;
  const shotStyles = [
    { scale: 1.00, height: .66, x: 0, y: .04, fit: "cover", glowX: "18%", glowY: "16%" },
    { scale: 1.00, height: .64, x: 0, y: .06, fit: "cover", glowX: "80%", glowY: "20%" },
    { scale: 1.00, height: .62, x: 0, y: .08, fit: "cover", glowX: "25%", glowY: "42%" },
    { scale: .92, height: .60, x: .04, y: .08, fit: "cover", glowX: "78%", glowY: "34%" },
    { scale: .88, height: .64, x: .06, y: .04, fit: "cover", glowX: "50%", glowY: "18%" },
    { scale: .78, height: .58, x: .11, y: .08, fit: "cover", glowX: "50%", glowY: "26%" },
    { scale: .86, height: .64, x: .07, y: .04, fit: "cover", glowX: "70%", glowY: "18%" },
    { scale: .70, height: .52, x: .15, y: .12, fit: "cover", glowX: "50%", glowY: "28%" }
  ];
  const outputs = [];
  const existingByShot = new Map(existingKeyframes.map(frame => [frame.shotId, frame]));
  const selectedShots = new Set(onlyShotIds);
  // The installed LTX 2B model is strongest on macro product cinematography.
  // When a garment photo contains a wearer, these trusted crops stay below the
  // face and away from hands rather than asking the model to reconstruct or
  // animate a person. FramePack keeps the plan's original framing.
  const ltxProductCrops = [
    { x: .50, y: .78, zoom: 3.45 },
    { x: .50, y: .84, zoom: 4.00 },
    { x: .72, y: .64, zoom: 4.00 },
    { x: .22, y: .64, zoom: 4.00 },
    { x: .50, y: .68, zoom: 4.00 },
    { x: .60, y: .84, zoom: 3.80 },
    { x: .68, y: .69, zoom: 3.90 },
    { x: .34, y: .82, zoom: 3.70 }
  ];
  const productOnly = config.videoMotionProvider === "ltx" && config.ltxProductOnly;
  const textileProduct = /(?:apparel|fashion|clothing|garment|kurti|tunic|dress|shirt|blouse|jacket)/i.test(`${brief.category || ""} ${brief.product || ""}`);
  const ltxProfile = productOnly ? (textileProduct ? "textile-macro" : "rigid-product") : null;
  for (let index = 0; index < plan.shots.length; index += 1) {
    const shot = plan.shots[index];
    if (selectedShots.size && !selectedShots.has(shot.id) && existingByShot.has(shot.id)) {
      outputs.push(existingByShot.get(shot.id));
      continue;
    }
    if (shot.sceneType === "PEOPLE" && config.videoWorkerMode === "worker") {
      const frame = await peopleSceneFrame(shot, brief, width, height);
      const stored = await storeMedia({
        bytes: frame,
        mimeType: "image/png",
        filename: `${jobId}-${shot.id}-people-keyframe.png`,
        kind: "VIDEO_SCENE_KEYFRAME",
        metadata: { videoJobId: jobId, shotId: shot.id, shotIndex: index, width, height, source: "GENERATED_PEOPLE_SCENE" }
      });
      outputs.push({ assetId: stored.id, shotId: shot.id, mimeType: stored.mimeType, width, height, byteLength: stored.byteLength, source: "GENERATED_PEOPLE_SCENE" });
      continue;
    }
    const style = shotStyles[index % shotStyles.length];
    const productFocus = ltxProfile === "textile-macro" ? ltxProductCrops[index % ltxProductCrops.length] : shot.focus;
    const productWidth = Math.round(width * style.scale);
    const productHeight = Math.round(height * style.height);
    const assetId = productAssetIds.length ? productAssetIds[index % productAssetIds.length] : null;
    const product = await productLayer(assetId, productWidth, productHeight, accent, style.fit, productFocus);
    const headlineLines = wrapHeadline(shot.copy?.headline || "");
    const headlineFontSize = Math.round(width * (headlineLines.some(line => line.length > 18) ? .054 : .066));
    const headline = headlineLines.map((line, lineIndex) => `<tspan x="${width * .09}" dy="${lineIndex ? headlineFontSize * 1.12 : 0}">${xml(line)}</tspan>`).join("");
    const eyebrow = xml(shot.copy?.eyebrow || "");
    const subheadline = xml(shot.copy?.subheadline || "");
    const backdrop = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><radialGradient id="glow" cx="${style.glowX}" cy="${style.glowY}" r="75%"><stop stop-color="${accent}" stop-opacity=".48"/><stop offset="1" stop-color="${background}" stop-opacity="0"/></radialGradient><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${background}"/><stop offset=".58" stop-color="${background}"/><stop offset="1" stop-color="#050505"/></linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#fade)"/><rect width="${width}" height="${height}" fill="url(#glow)"/>
    </svg>`;
    const typography = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><linearGradient id="textScrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".78"/></linearGradient></defs>
      <rect y="${height * .52}" width="${width}" height="${height * .48}" fill="url(#textScrim)"/>
      <path d="M${width * .09} ${height * .735}H${width * .19}" stroke="${accent}" stroke-width="${Math.max(2, Math.round(width * .002))}"/>
      <text x="${width * .09}" y="${height * .10}" fill="${accent}" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .025)}" font-weight="600" letter-spacing="${Math.round(width * .007)}">${eyebrow.toUpperCase()}</text>
      <text x="${width * .09}" y="${height * .79}" fill="#F7F5EF" font-family="Georgia,serif" font-size="${headlineFontSize}" font-weight="400">${headline}</text>
      <text x="${width * .09}" y="${height * .835}" fill="#F7F5EF" opacity=".70" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .029)}" font-weight="400">${subheadline}</text>
      <text x="${width * .09}" y="${height * .93}" fill="#F7F5EF" opacity=".56" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .019)}" letter-spacing="${Math.round(width * .004)}">${xml(brief.brand || brief.category || "PRODUCT FILM").toUpperCase()}</text>
      <text x="${width * .91}" y="${height * .93}" text-anchor="end" fill="#F7F5EF" opacity=".42" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .019)}">${String(index + 1).padStart(2, "0")}</text>
    </svg>`;
    const typographyOverlay = await sharp(Buffer.from(typography)).png().toBuffer();
    // Motion generation must see a complete photographic frame. The previous
    // plate placed a partial crop over a large branded-color canvas; I2V then
    // faithfully animated that empty canvas and sometimes completed cropped
    // anatomy incorrectly. Keep layout and typography out of the model input.
    const motionPlate = assetId
      ? ltxProfile === "rigid-product"
        ? await rigidProductPlate(assetId, width, height, background, accent, style, shot, index)
        : await productLayer(assetId, width, height, accent, "cover", productFocus)
      : await sharp(Buffer.from(backdrop)).composite([
          { input: product, left: Math.round(width * style.x), top: Math.round(height * style.y) }
        ]).png().toBuffer();
    const frame = await sharp(motionPlate).composite([{ input: typographyOverlay, left: 0, top: 0 }]).png().toBuffer();
    const plateStored = await storeMedia({
      bytes: motionPlate,
      mimeType: "image/png",
      filename: `${jobId}-${shot.id}-motion-plate.png`,
      kind: "VIDEO_MOTION_PLATE",
      metadata: { videoJobId: jobId, shotId: shot.id, shotIndex: index, width, height }
    });
    const overlayStored = await storeMedia({
      bytes: typographyOverlay,
      mimeType: "image/png",
      filename: `${jobId}-${shot.id}-typography.png`,
      kind: "VIDEO_TYPOGRAPHY_OVERLAY",
      metadata: { videoJobId: jobId, shotId: shot.id, shotIndex: index, width, height }
    });
    const stored = await storeMedia({
      bytes: frame,
      mimeType: "image/png",
      filename: `${jobId}-${shot.id}-keyframe.png`,
      kind: "VIDEO_KEYFRAME",
      metadata: { videoJobId: jobId, shotId: shot.id, shotIndex: index, width, height }
    });
    outputs.push({ assetId: stored.id, motionPlateAssetId: plateStored.id, overlayAssetId: overlayStored.id, shotId: shot.id, mimeType: stored.mimeType, width, height, byteLength: stored.byteLength, productOnly, ltxProfile });
  }
  return outputs;
}
