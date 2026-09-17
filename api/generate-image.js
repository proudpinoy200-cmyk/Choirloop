// POST { prompt: string, agent?: { name, tone, directness, focus, risk, traits } }
// -> { image: "https://...public blob url.../xyz.png" }
//
// Before generating, the raw prompt is expanded into a richer, more specific art-direction
// prompt (style, lighting, composition) by a text model, optionally shaped by the agent's
// personality. This produces noticeably better results than sending short raw phrases like
// "a butterfly" straight to the image model. If enhancement fails for any reason, falls back
// to the original prompt so image generation is never blocked by this optional step.
//
// Requires env vars:
//   OPENAI_API_KEY        (image generation, and text fallback for prompt enhancement)
//   ANTHROPIC_API_KEY     (optional - preferred for prompt enhancement if present)
//   BLOB_READ_WRITE_TOKEN (auto-added when a Vercel Blob store is connected to this project)

const { put } = require("@vercel/blob");

async function checkUsageCap(reqHeaders) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return { ok: true };

  const GLOBAL_DAILY_CAP = 300;
  const USER_DAILY_CAP = 3;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const globalRes = await fetch(base + "/incr/" + encodeURIComponent("choir:usage:global:" + today), {
      method: "POST",
      headers: { Authorization: "Bearer " + token }
    });
    const globalData = await globalRes.json();
    if ((globalData.result || 0) > GLOBAL_DAILY_CAP) {
      return { ok: false, reason: "Choir's shared daily creative budget is used up for today \u2014 check back tomorrow." };
    }

    const cookies = {};
    (reqHeaders.cookie || "").split(";").forEach(function (pair) {
      var idx = pair.indexOf("=");
      if (idx === -1) return;
      cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    const sessionToken = cookies.choir_session;
    if (sessionToken) {
      const userIdRes = await fetch(base + "/get/" + encodeURIComponent("choir:session:" + sessionToken), {
        headers: { Authorization: "Bearer " + token }
      });
      const userIdData = await userIdRes.json();
      let userId = null;
      if (userIdData && userIdData.result != null) {
        try { userId = JSON.parse(userIdData.result); } catch (e) { userId = null; }
      }
      if (userId) {
        const userRes = await fetch(base + "/incr/" + encodeURIComponent("choir:usage:user:" + userId + ":" + today), {
          method: "POST",
          headers: { Authorization: "Bearer " + token }
        });
        const userData = await userRes.json();
        if ((userData.result || 0) > USER_DAILY_CAP) {
          return { ok: false, reason: "You've hit today's limit for images, songs, and voice (3/day) \u2014 resets tomorrow." };
        }
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("Usage cap check failed, allowing through", e && e.message);
    return { ok: true };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const capCheck = await checkUsageCap(req.headers);
  if (!capCheck.ok) {
    res.status(429).json({ error: capCheck.reason });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing OPENAI_API_KEY" });
    return;
  }

  const body = req.body || {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 800) : "";
  const agent = body.agent && typeof body.agent === "object" ? body.agent : null;
  if (!prompt) {
    res.status(400).json({ error: "Missing prompt" });
    return;
  }

  const artPrompt = await buildArtPrompt(prompt, agent).catch(function () { return prompt; });

  try {
    const upstream = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: artPrompt || prompt,
        n: 1,
        size: "1024x1024",
        quality: "high"
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

async function buildArtPrompt(topic, agent) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY1;
  const openaiKey = process.env.OPENAI_API_KEY;

  const traits = agent && Array.isArray(agent.traits) ? agent.traits.filter(Boolean).join(", ") : "";
  const personalityLine = agent
    ? "The requester's personality/vibe to let loosely inform mood and style (do not mention them explicitly): " +
      [agent.tone, agent.directness, agent.focus, agent.risk, traits].filter(Boolean).join(", ") + "."
    : "";

  const systemPrompt = [
    "You write prompts for an image generation model.",
    "Given a short subject, expand it into ONE vivid, specific prompt: mention concrete visual details, an art style or medium, lighting, mood, and composition.",
    "Keep it to 1-2 sentences. Output ONLY the prompt text - no preamble, no quotes, no labels.",
    personalityLine
  ].filter(Boolean).join(" ");

  if (anthropicKey) {
    try {
      return await callAnthropicText(anthropicKey, systemPrompt, topic);
    } catch (err) {
      console.error("art prompt enhancement (anthropic) failed", err && err.message);
    }
  }
  if (openaiKey) {
    try {
      return await callOpenAIText(openaiKey, systemPrompt, topic);
    } catch (err) {
      console.error("art prompt enhancement (openai) failed", err && err.message);
    }
  }
  return topic;
}

async function callAnthropicText(key, systemPrompt, topic) {
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: topic }]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Anthropic request failed");
  var block = data.content && data.content.find(function (c) { return c.type === "text"; });
  var text = block && block.text && block.text.trim();
  if (!text) throw new Error("empty enhancement");
  return text;
}

async function callOpenAIText(key, systemPrompt, topic) {
  var r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      max_completion_tokens: 150,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: topic }
      ]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "OpenAI request failed");
  var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  text = text && text.trim();
  if (!text) throw new Error("empty enhancement");
  return text;
}
