import test from "node:test";
import assert from "node:assert/strict";
import { buildQueries, buildScenePrompts, buildSceneQueries, validateBrief } from "../src/brief.js";
import { createDeterministicPlan, scoreCandidates } from "../src/planner.js";

test("validates and normalizes a minimal brief", () => {
  const brief = validateBrief({ product: "Air Max 270", brand: "Nike" });
  assert.equal(brief.callToAction, "Discover the details");
  assert.equal(buildQueries(brief).length, 4);
});

test("builds safe scene searches and no-product generation prompts", () => {
  const brief = validateBrief({ product: "Air Max 270", brand: "Nike", category: "sneakers", tone: "futuristic" });
  assert.equal(buildSceneQueries(brief).length, 3);
  assert.equal(buildScenePrompts(brief).length, 3);
  assert.match(buildScenePrompts(brief)[0], /no product/i);
});

test("creates one strongest prototype design", () => {
  const brief = validateBrief({ product: "Air Max 270", brand: "Nike", model: "AH8050", features: ["Air cushioning"] });
  const designs = createDeterministicPlan(brief);
  assert.equal(designs.length, 1);
  assert.equal(new Set(designs.map(item => item.accent)).size, 1);
});

test("ranks exact product matches above generic results", () => {
  const brief = validateBrief({ product: "Air Max 270", brand: "Nike", model: "AH8050" });
  const ranked = scoreCandidates([
    { title: "generic shoe", source: "blog", width: 500, height: 500 },
    { title: "Nike Air Max 270 AH8050", source: "official brand", width: 1200, height: 1200 }
  ], brief);
  assert.match(ranked[0].title, /AH8050/);
});
