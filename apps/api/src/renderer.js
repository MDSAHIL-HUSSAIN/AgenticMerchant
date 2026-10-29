import sharp from "sharp";
import { readMedia } from "./media-store.js";

const xml = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function dataUri(bytes, mimeType) {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function demoProductSvg(label, accent = "#B9FF38") {
  const lower = String(label).toLowerCase();
  let object;
  if (/kurti|dress|shirt|clothing|fashion|top|jacket|hoodie/.test(lower)) {
    object = `<path d="M420 260 520 190h160l100 70 170 160-115 125-90-80v390H455V465l-90 80-115-125Z" fill="${accent}"/><path d="M520 190c20 85 140 85 160 0" fill="#171719"/><path d="M600 270v470" stroke="#fff" stroke-width="14" opacity=".75"/><g fill="#fff">${[350,440,530,620].map(y => `<circle cx="600" cy="${y}" r="9"/>`).join("")}</g>`;
  } else if (/bag|purse|handbag/.test(lower)) {
    object = `<path d="M300 420h600l-55 440H355Z" fill="${accent}"/><path d="M445 430c0-230 310-230 310 0" fill="none" stroke="#171719" stroke-width="38"/><circle cx="600" cy="600" r="45" fill="#fff" opacity=".8"/>`;
  } else {
    object = `<path d="M220 690C310 430 445 290 640 270c165-17 280 90 350 290 28 80-20 165-105 185l-515 115c-120 27-190-62-150-170Z" fill="#171719"/><path d="M315 635c170-190 350-260 535-125l64 83-560 130Z" fill="${accent}"/><path d="M235 750l695-155c82-18 112 98 26 127L350 880c-100 26-160-48-115-130Z" fill="#fff"/>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200"><rect width="1200" height="1200" fill="#f2efe8"/><ellipse cx="600" cy="900" rx="360" ry="55" fill="#000" opacity=".12"/>${object}<text x="70" y="1080" font-family="Arial,sans-serif" font-size="38" font-weight="700" fill="#171719">${xml(label)}</text></svg>`);
}

async function assetBytes(asset, label, accent) {
  if (!asset) return { bytes: demoProductSvg(label, accent), mimeType: "image/svg+xml" };
  if (asset.assetId) {
    const stored = await readMedia(asset.assetId);
    return { bytes: stored.bytes, mimeType: stored.record.mimeType };
  }
  const url = String(asset.url || asset.thumbnail || "");
  const encoded = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (encoded) return { bytes: Buffer.from(encoded[2], "base64"), mimeType: encoded[1] };
  if (url.includes("/api/demo-image/")) return { bytes: demoProductSvg(label, accent), mimeType: "image/svg+xml" };
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "DesignAgentRenderer/1.0" } });
    if (!response.ok) throw new Error(`Product image returned ${response.status}.`);
    const mimeType = (response.headers.get("content-type") || "").split(";")[0];
    if (!mimeType.startsWith("image/")) throw new Error("Product asset is not an image.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024) throw new Error("Product asset exceeds 12 MB.");
    return { bytes, mimeType };
  }
  return { bytes: demoProductSvg(label, accent), mimeType: "image/svg+xml" };
}

async function normalizeRasterAsset(asset) {
  const bytes = await sharp(asset.bytes, { limitInputPixels: 50_000_000 })
    .rotate()
    .png({ compressionLevel: 8 })
    .toBuffer();
  return { bytes, mimeType: "image/png" };
}

function wrapText(value, width, fontSize, maxLines) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const maxChars = Math.max(8, Math.floor(width / (fontSize * 0.56)));
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const consumed = lines.join(" ").length;
  if (consumed < String(value || "").length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.…]+$/, "").slice(0, Math.max(1, maxChars - 1))}…`;
  }
  return lines;
}

function textSvg(lines, { x, y, fontSize, lineHeight, fill, weight = 700, letterSpacing = 0 }) {
  return `<text x="${x}" y="${y}" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="${weight}" letter-spacing="${letterSpacing}" fill="${fill}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${xml(line)}</tspan>`).join("")}</text>`;
}

function motifSvg(design, width, height) {
  const accent = design.accent;
  if (design.motif === "contour") return `<path d="M${width * .68} 0C${width * .58} ${height * .28} ${width * .9} ${height * .42} ${width * .72} ${height}" fill="none" stroke="${accent}" stroke-width="18" opacity=".34"/>`;
  if (design.motif === "precision-grid") return `<g stroke="${accent}" opacity=".16">${[1,2,3,4].map(n => `<path d="M0 ${n * height / 5}H${width}M${n * width / 5} 0V${height}"/>`).join("")}</g>`;
  if (design.motif === "motion-lines") return `<g stroke="${accent}" stroke-width="13" opacity=".35">${[0,1,2].map(n => `<path d="M${width * .08} ${height * (.72 + n * .06)}H${width * (.32 + n * .08)}"/>`).join("")}</g>`;
  if (design.motif === "material-dots") return `<g fill="${accent}" opacity=".45">${[0,1,2,3,4,5].map(n => `<circle cx="${width * (.72 + (n % 3) * .07)}" cy="${height * (.12 + Math.floor(n / 3) * .07)}" r="9"/>`).join("")}</g>`;
  return "";
}

export async function renderDesign({ brief, design, assets = [], backgroundAssets = [], scale = 1 }) {
  const width = Math.round(1080 * scale);
  const height = Math.round(1080 * scale);
  const c = Object.fromEntries(Object.entries(design.composition || {}).map(([key, value]) => [key, Number(value) * scale]));
  const product = await normalizeRasterAsset(await assetBytes(assets[design.imageIndex % Math.max(1, assets.length)], brief.product, design.accent));
  const productUri = dataUri(product.bytes, product.mimeType);
  let backgroundImage = "";
  const backgroundAsset = backgroundAssets[design.backgroundIndex];
  if (backgroundAsset) {
    try {
      const background = await normalizeRasterAsset(await assetBytes(backgroundAsset, "", design.accent));
      backgroundImage = `<image href="${dataUri(background.bytes, background.mimeType)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity=".68"/><rect width="${width}" height="${height}" fill="${design.background}" opacity="${design.overlayOpacity}"/>`;
    } catch {
      backgroundImage = "";
    }
  }
  const eyebrowSize = 18 * scale;
  const headlineSize = c.headlineSize;
  const headlineLines = wrapText(design.headline, c.textWidth, headlineSize, 3);
  const headlineHeight = headlineSize * 1.02;
  const eyebrowBaseline = c.textY + eyebrowSize;
  const headlineBaseline = c.textY + eyebrowSize * 2.5 + headlineSize;
  const subY = headlineBaseline + Math.max(0, headlineLines.length - 1) * headlineHeight + 52 * scale;
  const subLines = wrapText(design.subheadline, c.textWidth, 25 * scale, 3);
  const radius = 28 * scale;
  const productFrame = design.imageTreatment === "isolated-stage"
    ? `<ellipse cx="${c.productX + c.productWidth / 2}" cy="${c.productY + c.productHeight * .89}" rx="${c.productWidth * .42}" ry="${c.productHeight * .07}" fill="#000" opacity=".18"/>`
    : `<rect x="${c.productX}" y="${c.productY}" width="${c.productWidth}" height="${c.productHeight}" rx="${radius}" fill="${design.textColor}" opacity=".08"/>`;
  const clipId = `clip-${design.kind}-${Math.round(c.productX)}`.replace(/[^a-z0-9-]/gi, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="surface" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${design.background}"/><stop offset="1" stop-color="${design.accent}" stop-opacity=".28"/></linearGradient><clipPath id="${clipId}"><rect x="${c.productX}" y="${c.productY}" width="${c.productWidth}" height="${c.productHeight}" rx="${radius}"/></clipPath></defs>
    <rect width="${width}" height="${height}" fill="url(#surface)"/>${backgroundImage}${motifSvg(design, width, height)}
    ${productFrame}<image href="${productUri}" x="${c.productX}" y="${c.productY}" width="${c.productWidth}" height="${c.productHeight}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>
    ${textSvg([String(design.eyebrow || "").toUpperCase()], { x: c.textX, y: eyebrowBaseline, fontSize: eyebrowSize, lineHeight: 0, fill: design.accent, weight: 700, letterSpacing: 3 * scale })}
    ${textSvg(headlineLines, { x: c.textX, y: headlineBaseline, fontSize: headlineSize, lineHeight: headlineHeight, fill: design.textColor, weight: 800 })}
    ${textSvg(subLines, { x: c.textX, y: subY, fontSize: 25 * scale, lineHeight: 32 * scale, fill: design.textColor, weight: 400 })}
    <path d="M${64 * scale} ${1000 * scale}H${1016 * scale}" stroke="${design.textColor}" opacity=".3"/>
    <text x="${64 * scale}" y="${1034 * scale}" font-family="Arial,sans-serif" font-size="${15 * scale}" letter-spacing="${2 * scale}" fill="${design.textColor}" opacity=".8">${xml(brief.brand || brief.category || "PRODUCT SERIES")}</text>
    <text x="${1016 * scale}" y="${1034 * scale}" text-anchor="end" font-family="Arial,sans-serif" font-size="${15 * scale}" fill="${design.textColor}" opacity=".7">${xml(design.kind.toUpperCase())}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function renderPack(input) {
  return Promise.all(input.designs.map(design => renderDesign({ ...input, design })));
}
