import sharp from "sharp";
import { config } from "./config.js";
import { readMedia, storeMedia } from "./media-store.js";
import { generateCloudflareBackground } from "./providers.js";

const xml = value => String(value || "").replace(/[<>&\"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" }[character]));

async function productLayer(assetId, width, height, accent, fit = "contain") {
  if (assetId) {
    try {
      const { bytes } = await readMedia(assetId);
      return await sharp(bytes).resize(width, height, { fit, position: "attention", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
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
  const width = config.videoPreviewWidth;
  const height = config.videoPreviewHeight;
  const [background, textColor, accent = "#B8C2CF"] = plan.palette;
  const shotStyles = [
    { scale: 1.00, height: .62, x: 0, y: .08, fit: "cover", glowX: "20%", glowY: "18%" },
    { scale: .66, height: .50, x: .26, y: .18, fit: "contain", glowX: "82%", glowY: "22%" },
    { scale: .82, height: .58, x: .09, y: .14, fit: "contain", glowX: "50%", glowY: "28%" },
    { scale: 1.00, height: .52, x: 0, y: .10, fit: "cover", glowX: "15%", glowY: "40%" },
    { scale: .96, height: .60, x: .02, y: .06, fit: "cover", glowX: "88%", glowY: "35%" },
    { scale: .72, height: .48, x: .18, y: .24, fit: "contain", glowX: "25%", glowY: "20%" },
    { scale: .90, height: .61, x: .05, y: .11, fit: "contain", glowX: "70%", glowY: "18%" },
    { scale: .58, height: .43, x: .21, y: .22, fit: "contain", glowX: "50%", glowY: "28%" }
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
    const product = await productLayer(assetId, productWidth, productHeight, accent, style.fit);
    const headline = xml(shot.copy?.headline || "");
    const eyebrow = xml(shot.copy?.eyebrow || "");
    const subheadline = xml(shot.copy?.subheadline || "");
    const layout = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs><radialGradient id="glow" cx="${style.glowX}" cy="${style.glowY}" r="75%"><stop stop-color="${accent}" stop-opacity=".48"/><stop offset="1" stop-color="${background}" stop-opacity="0"/></radialGradient><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${background}"/><stop offset=".58" stop-color="${background}"/><stop offset="1" stop-color="#050505"/></linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#fade)"/><rect width="${width}" height="${height}" fill="url(#glow)"/>
      <g opacity=".14" stroke="${textColor}"><path d="M${width * .08} 0V${height}"/><path d="M${width * .92} 0V${height}"/><path d="M0 ${height * .12}H${width}"/><path d="M0 ${height * .88}H${width}"/></g>
      <text x="${width * .09}" y="${height * .1}" fill="${accent}" font-family="Arial,sans-serif" font-size="${Math.round(width * .031)}" font-weight="700" letter-spacing="${Math.round(width * .008)}">${eyebrow.toUpperCase()}</text>
      <text x="${width * .09}" y="${height * .77}" fill="#F7F5EF" font-family="Arial,sans-serif" font-size="${Math.round(width * .078)}" font-weight="700">${headline}</text>
      <text x="${width * .09}" y="${height * .82}" fill="#F7F5EF" opacity=".72" font-family="Arial,sans-serif" font-size="${Math.round(width * .034)}">${subheadline}</text>
      <text x="${width * .09}" y="${height * .93}" fill="#F7F5EF" opacity=".52" font-family="Arial,sans-serif" font-size="${Math.round(width * .023)}" letter-spacing="2">${xml(brief.brand || brief.category || "PRODUCT FILM").toUpperCase()}</text>
      <text x="${width * .91}" y="${height * .93}" text-anchor="end" fill="#F7F5EF" opacity=".52" font-family="Arial,sans-serif" font-size="${Math.round(width * .023)}">${String(index + 1).padStart(2, "0")}</text>
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
