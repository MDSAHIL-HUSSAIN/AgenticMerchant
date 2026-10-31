const clean = value => String(value || "").trim();

export async function planGeminiPrompt(job, config) {
  const request = job.request || {};
  const facts = {
    productName: clean(request.productName), brand: clean(request.brand), category: clean(request.category),
    offer: clean(request.offer), couponCode: clean(request.couponCode), callToAction: clean(request.callToAction),
    instructions: clean(request.instructions), durationSeconds: request.durationSeconds || 8, aspectRatio: "9:16"
  };
  const system = `You are the creative director for a merchant advertisement. Produce ONE complete Gemini video-generation prompt, not an explanation and not JSON. The generated clip must be a self-contained vertical social advertisement with coherent scene progression, realistic product presentation, cinematic camera movement, lighting, environment, pacing, sound effects, music and spoken audio when appropriate. Preserve all supplied product and offer facts exactly. Do not invent prices, claims, coupon codes, packaging, logos or legal claims. Ask Gemini to render any supplied on-screen wording exactly, keep it readable, and avoid extra text. The final output must be ${facts.durationSeconds} seconds, 9:16, and ready to publish without editing.`;
  const user = `Merchant facts:\n${JSON.stringify(facts, null, 2)}\n\nWrite the single production-ready video prompt now.`;
  try {
    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.ollamaModel, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }], options: { temperature: 0.65 } }),
      signal: AbortSignal.timeout(120_000)
    });
    const body = await response.json().catch(() => ({}));
    const prompt = clean(body.message?.content);
    if (!response.ok || !prompt) throw new Error(body.error || `Ollama returned HTTP ${response.status}.`);
    return prompt;
  } catch (error) {
    if (config.qwenRequired) throw new Error(`Qwen creative planning failed: ${error.message}`);
    return `${system}\n\nMerchant facts:\n${JSON.stringify(facts, null, 2)}`;
  }
}
