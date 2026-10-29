import { writeFile } from "node:fs/promises";
import { generateCloudflareBackground } from "../apps/api/src/providers.js";

const result = await generateCloudflareBackground("A cinematic vertical advertising still of a confident young Indian woman walking through a sunlit modern city in an elegant cotton kurti, candid natural movement, realistic hands and skin, premium editorial cinematography, no text, no logo, no watermark");
const match = result?.url?.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
if (!match) throw new Error("No people scene was generated.");
const output = new URL("../artifacts/people-scene-proof.jpg", import.meta.url);
await writeFile(output, Buffer.from(match[1], "base64"));
console.log(output.pathname.slice(1));
