import test from "node:test";
import assert from "node:assert/strict";
import { addDraftMessage, answerClarification, draftToDesignInput } from "../src/drafts.js";
import { validateBrief } from "../src/brief.js";
import { createDeterministicPlan } from "../src/planner.js";
import { renderWithQualityLoop } from "../src/quality.js";

test("collects a multimodal product draft and prepares a normalized design input", async () => {
  const metadata = {
    merchantId: "merchant-test",
    conversationId: `conversation-${crypto.randomUUID()}`,
    productName: "Cotton Kurti",
    brand: "Kavya Boutique",
    cost: 500,
    price: 799,
    sizes: ["M", "L"],
    mediaRoles: { product_image: "PRIMARY_PRODUCT" }
  };
  const draft = await addDraftMessage({
    metadata,
    text: "Warm festive premium",
    files: [{
      fieldname: "product_image",
      originalname: "kurti-front.svg",
      mimetype: "image/svg+xml",
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#a43f22"/></svg>')
    }]
  });
  assert.equal(draft.status, "BRIEF_READY");
  assert.equal(draft.facts.productName, "Cotton Kurti");
  assert.equal(draft.media[0].role, "PRIMARY_PRODUCT");
  const input = draftToDesignInput(draft.id);
  assert.equal(input.brief.product, "Cotton Kurti");
  assert.equal(input.productAssetIds.length, 1);
});

test("pauses an ambiguous image until its role is clarified", async () => {
  const draft = await addDraftMessage({
    metadata: { merchantId: "merchant-test", conversationId: `conversation-${crypto.randomUUID()}`, productName: "Leather Bag", cost: 1200 },
    files: [{ fieldname: "images", originalname: "photo.svg", mimetype: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>') }]
  });
  assert.equal(draft.status, "NEEDS_CLARIFICATION");
  const question = draft.questions.find(item => item.field === "imageRoles");
  const resolved = answerClarification(draft.id, { questionId: question.id, answer: "product" });
  assert.equal(resolved.status, "BRIEF_READY");
  assert.equal(resolved.media[0].role, "PRIMARY_PRODUCT");
});

test("does not delay an image brief when Shopify cost is missing", async () => {
  const draft = await addDraftMessage({
    metadata: {
      merchantId: "merchant-test",
      conversationId: `conversation-${crypto.randomUUID()}`,
      productName: "Leather Bag",
      targetChannels: ["shopify"],
      mediaRoles: { product_image: "PRIMARY_PRODUCT" }
    },
    files: [{ fieldname: "product_image", originalname: "bag.svg", mimetype: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>') }]
  });
  assert.equal(draft.status, "BRIEF_READY");
  assert.equal(draft.questions.some(item => item.field === "cost"), false);
  assert.equal(draft.facts.cost, null);
  assert.equal(draft.facts.price, null);
});

test("renders one autonomous preview and passes deterministic quality gates", async () => {
  const brief = validateBrief({ product: "Cotton Kurti", brand: "Kavya Boutique", features: ["Soft cotton", "Festive detailing"] });
  const result = await renderWithQualityLoop({ brief, designs: createDeterministicPlan(brief), assets: [], backgroundAssets: [] });
  assert.equal(result.buffers.length, 1);
  assert.equal(result.designs.length, 1);
  assert.ok(result.buffers.every(buffer => buffer.subarray(1, 4).toString() === "PNG"));
  assert.ok(result.qa.scores.every(score => score >= 70));
});
