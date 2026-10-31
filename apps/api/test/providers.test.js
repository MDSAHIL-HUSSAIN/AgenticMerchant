import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { generateCloudflareBackground, removeProductBackground, searchPixabayImages } from "../src/providers.js";

test("removes a selected product background as a reusable transparent PNG", async t => {
  const original = {
    key: config.removeBgApiKey,
    size: config.removeBgSize,
    fetch: globalThis.fetch
  };
  t.after(() => {
    config.removeBgApiKey = original.key;
    config.removeBgSize = original.size;
    globalThis.fetch = original.fetch;
  });
  config.removeBgApiKey = "remove-bg-test-key";
  config.removeBgSize = "auto";
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://api.remove.bg/v1.0/removebg");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-Api-Key"], "remove-bg-test-key");
    assert.equal(options.body.get("size"), "auto");
    assert.equal(options.body.get("type"), "product");
    assert.equal(options.body.get("format"), "png");
    assert.equal(options.body.get("image_file").type, "image/jpeg");
    return new Response(Buffer.from("transparent-png"), {
      status: 200,
      headers: { "content-type": "image/png", "x-credits-charged": "1" }
    });
  };

  const result = await removeProductBackground({
    bytes: Buffer.from("source-image"),
    mimeType: "image/jpeg",
    filename: "product.jpg"
  });
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.bytes.toString(), "transparent-png");
  assert.equal(result.creditsCharged, "1");
});

test("maps Pixabay results into attributed background assets", async t => {
  const originalKey = config.pixabayApiKey;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    config.pixabayApiKey = originalKey;
    globalThis.fetch = originalFetch;
  });
  config.pixabayApiKey = "test-key";
  globalThis.fetch = async url => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.searchParams.get("image_type"), "photo");
    assert.equal(requestUrl.searchParams.get("safesearch"), "true");
    return Response.json({ hits: [{
      largeImageURL: "https://cdn.example/background.jpg",
      previewURL: "https://cdn.example/preview.jpg",
      tags: "studio, abstract",
      user: "Artist",
      pageURL: "https://pixabay.com/photos/example",
      imageWidth: 1920,
      imageHeight: 1080
    }] });
  };
  const assets = await searchPixabayImages(["premium sneaker background"]);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].source, "Pixabay · Artist");
  assert.equal(assets[0].kind, "stock-background");
});

test("converts a Cloudflare FLUX response into a temporary image asset", async t => {
  const original = {
    accountId: config.cloudflareAccountId,
    token: config.cloudflareApiToken,
    model: config.cloudflareImageModel,
    fetch: globalThis.fetch
  };
  t.after(() => {
    config.cloudflareAccountId = original.accountId;
    config.cloudflareApiToken = original.token;
    config.cloudflareImageModel = original.model;
    globalThis.fetch = original.fetch;
  });
  config.cloudflareAccountId = "account-id";
  config.cloudflareApiToken = "token";
  config.cloudflareImageModel = "@cf/black-forest-labs/flux-1-schnell";
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
    assert.equal(options.headers.authorization, "Bearer token");
    assert.deepEqual(JSON.parse(options.body), { prompt: "abstract studio", steps: 4 });
    return Response.json({ success: true, result: { image: "YWJj" } });
  };
  const asset = await generateCloudflareBackground("abstract studio", 42);
  assert.equal(asset.url, "data:image/jpeg;base64,YWJj");
  assert.equal(asset.kind, "generated-background");
});
