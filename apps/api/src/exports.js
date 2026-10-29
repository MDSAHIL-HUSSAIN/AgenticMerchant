import sharp from "sharp";
import { readMedia, storeMedia } from "./media-store.js";

const formats = [
  { platform: "master", width: 2160, height: 2160 },
  { platform: "shopify", width: 1600, height: 1600 },
  { platform: "instagram_square", width: 1080, height: 1080 },
  { platform: "instagram_portrait", width: 1080, height: 1350 },
  { platform: "facebook_feed", width: 1200, height: 630 }
];

async function platformBuffer(input, width, height) {
  if (width === height) return sharp(input).resize(width, height, { fit: "fill" }).png({ compressionLevel: 8 }).toBuffer();
  const background = await sharp(input)
    .resize(width, height, { fit: "cover" })
    .blur(Math.max(10, Math.round(Math.min(width, height) / 35)))
    .modulate({ brightness: .72, saturation: .82 })
    .png()
    .toBuffer();
  const margin = Math.round(Math.min(width, height) * .045);
  const foreground = await sharp(input)
    .resize(width - margin * 2, height - margin * 2, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });
  return sharp(background)
    .composite([{ input: foreground.data, left: Math.round((width - foreground.info.width) / 2), top: Math.round((height - foreground.info.height) / 2) }])
    .png({ compressionLevel: 8 })
    .toBuffer();
}

export async function createFinalExports(job, designIds) {
  const selected = new Set(designIds);
  const outputs = [];
  for (let designIndex = 0; designIndex < job.designs.length; designIndex += 1) {
    const design = job.designs[designIndex];
    if (!selected.has(design.id)) continue;
    const preview = job.previewAssets.find(asset => Number(asset.designIndex) === designIndex);
    if (!preview) throw new Error(`Preview asset is missing for ${design.id}.`);
    const { bytes } = await readMedia(preview.assetId);
    for (const format of formats) {
      const rendered = await platformBuffer(bytes, format.width, format.height);
      const stored = await storeMedia({
        bytes: rendered,
        mimeType: "image/png",
        filename: `${job.id}-${design.id}-${format.platform}.png`,
        kind: "FINAL_DESIGN",
        metadata: {
          designJobId: job.id,
          revisionId: job.currentRevisionId,
          designId: design.id,
          platform: format.platform,
          width: format.width,
          height: format.height
        }
      });
      outputs.push({
        assetId: stored.id,
        designId: design.id,
        platform: format.platform,
        width: format.width,
        height: format.height,
        mimeType: stored.mimeType,
        byteLength: stored.byteLength
      });
    }
  }
  return outputs;
}
