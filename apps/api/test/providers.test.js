import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { generateCloudflareBackground, searchPixabayImages } from "../src/providers.js";

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
