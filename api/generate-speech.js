// POST { text: string, agent: { name, tone, directness, focus, risk, traits } } -> { audioUrl }
//
// Uses OpenAI's gpt-4o-mini-tts. Each agent gets a consistent voice (deterministically picked
// from its name, so the same agent always sounds the same) plus a delivery-style instruction
// built from its personality - so this isn't just "pick a voice," it's the agent's actual tone
// shaping how the line is read.
//
// The result is uploaded to Vercel Blob and the URL returned - callers should cache that URL
// on the post so this only ever runs once per post, not on every play.
//
// Requires OPENAI_API_KEY (already used elsewhere) and BLOB_READ_WRITE_TOKEN.

const { put } = require("@vercel/blob");

const VOICE_POOL = ["alloy", "echo", "fable", "onyx", "nova", "shimmer", "ash", "coral", "sage"];

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
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 900) : "";
  const agent = body.agent && typeof body.agent === "object" ? body.agent : {};
  if (!text) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  const voice = pickVoiceForAgent(agent);
  const instructions = buildStyleInstructions(agent);

  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: voice,
        input: text,
        instructions: instructions
      })
    });

    if (!upstream.ok) {
      let detail = "";
      try { detail = JSON.stringify(await upstream.json()); } catch (e) { /* ignore */ }
      console.error("TTS generation failed", upstream.status, detail);
      res.status(upstream.status).json({ error: "Speech generation failed" });
      return;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const filename = `choir-speech/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const blob = await put(filename, buffer, {
      access: "public",
      contentType: "audio/mpeg",
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    res.status(200).json({ audioUrl: blob.url });
  } catch (err) {
    console.error("generate-speech failed", err && err.message);
    res.status(500).json({ error: "Speech generation request failed" });
  }
};

function pickVoiceForAgent(agent) {
  const str = (agent.name || "") + "|" + (agent.tone || "");
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = (hash * 31 + str.charCodeAt(i)) >>> 0; }
  return VOICE_POOL[hash % VOICE_POOL.length];
}

function buildStyleInstructions(agent) {
  const parts = [];
  if (agent.tone) parts.push(String(agent.tone).toLowerCase() + " in tone");
  if (agent.directness) parts.push(String(agent.directness).toLowerCase());
  if (agent.risk) parts.push(String(agent.risk).toLowerCase() + " delivery");
  if (!parts.length && Array.isArray(agent.traits) && agent.traits.length) {
    parts.push(agent.traits.slice(0, 3).join(", ").toLowerCase());
  }
  return parts.length ? ("Speak " + parts.join(", ") + ", matching this personality naturally - not exaggerated or cartoonish.") : "Speak naturally and conversationally.";
}
