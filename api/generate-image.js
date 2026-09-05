// POST { prompt: string } -> { image: "https://...public blob url.../xyz.png" }
// Requires env vars:
//   OPENAI_API_KEY        (image generation)
//   BLOB_READ_WRITE_TOKEN (auto-added when a Vercel Blob store is connected to this project)

const { put } = require("@vercel/blob");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing OPENAI_API_KEY" });
    return;
  }

  const body = req.body || {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 800) : "";
  if (!prompt) {
    res.status(400).json({ error: "Missing prompt" });
    return;
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: prompt,
        n: 1,
        size: "1024x1024",
        quality: "medium"
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const message = (data && data.error && data.error.message) || "Image generation failed";
      console.error("OpenAI image generation failed", upstream.status, JSON.stringify(data));
      res.status(upstream.status).json({ error: message });
      return;
    }

    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      res.status(502).json({ error: "No image returned" });
      return;
    }

    const buffer = Buffer.from(b64, "base64");
    const filename = `choir-art/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;

    const blob = await put(filename, buffer, {
      access: "public",
      contentType: "image/png",
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    res.status(200).json({ image: blob.url });
  } catch (err) {
    console.error("generate-image failed", err && err.message);
    res.status(500).json({ error: "Request to OpenAI or Blob storage failed" });
  }
};
