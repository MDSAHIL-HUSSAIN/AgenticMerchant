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
      const zoom = Math.max(1, Math.min(3, Number(focus?.zoom) || 1));
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

export async function renderVideoKeyframes({ jobId, brief, plan, productAssetIds = [] }) {
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
  for (let index = 0; index < plan.shots.length; index += 1) {
    const shot = plan.shots[index];
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
    const productWidth = Math.round(width * style.scale);
    const productHeight = Math.round(height * style.height);
    const assetId = productAssetIds.length ? productAssetIds[index % productAssetIds.length] : null;
    const product = await productLayer(assetId, productWidth, productHeight, accent, style.fit, shot.focus);
    const headlineLines = wrapHeadline(shot.copy?.headline || "");
    const headlineFontSize = Math.round(width * (headlineLines.some(line => line.length > 18) ? .054 : .066));
    const headline = headlineLines.map((line, lineIndex) => `<tspan x="${width * .09}" dy="${lineIndex ? headlineFontSize * 1.12 : 0}">${xml(line)}</tspan>`).join("");
    const eyebrow = xml(shot.copy?.eyebrow || "");
    const subheadline = xml(shot.copy?.subheadline || "");
    const layout = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><radialGradient id="glow" cx="${style.glowX}" cy="${style.glowY}" r="75%"><stop stop-color="${accent}" stop-opacity=".48"/><stop offset="1" stop-color="${background}" stop-opacity="0"/></radialGradient><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${background}"/><stop offset=".58" stop-color="${background}"/><stop offset="1" stop-color="#050505"/></linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#fade)"/><rect width="${width}" height="${height}" fill="url(#glow)"/>
      <path d="M${width * .09} ${height * .735}H${width * .19}" stroke="${accent}" stroke-width="${Math.max(2, Math.round(width * .002))}"/>
      <text x="${width * .09}" y="${height * .10}" fill="${accent}" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .025)}" font-weight="600" letter-spacing="${Math.round(width * .007)}">${eyebrow.toUpperCase()}</text>
      <text x="${width * .09}" y="${height * .79}" fill="#F7F5EF" font-family="Georgia,serif" font-size="${headlineFontSize}" font-weight="400">${headline}</text>
      <text x="${width * .09}" y="${height * .835}" fill="#F7F5EF" opacity=".70" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .029)}" font-weight="400">${subheadline}</text>
      <text x="${width * .09}" y="${height * .93}" fill="#F7F5EF" opacity=".56" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .019)}" letter-spacing="${Math.round(width * .004)}">${xml(brief.brand || brief.category || "PRODUCT FILM").toUpperCase()}</text>
      <text x="${width * .91}" y="${height * .93}" text-anchor="end" fill="#F7F5EF" opacity=".42" font-family="Segoe UI,sans-serif" font-size="${Math.round(width * .019)}">${String(index + 1).padStart(2, "0")}</text>
    </svg>`;
    const frame = await sharp(Buffer.from(layout)).composite([{ input: product, left: Math.round(width * style.x), top: Math.round(height * style.y) }]).png().toBuffer();
    const stored = await storeMedia({
      bytes: frame,
      mimeType: "image/png",
      filename: `${jobId}-${shot.id}-keyframe.png`,
      kind: "VIDEO_KEYFRAME",
      metadata: { videoJobId: jobId, shotId: shot.id, shotIndex: index, width, height }
    });
    outputs.push({ assetId: stored.id, shotId: shot.id, mimeType: stored.mimeType, width, height, byteLength: stored.byteLength });
  }
  return outputs;
}
