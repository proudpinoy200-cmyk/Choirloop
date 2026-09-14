// POST { topic: string, agent: { name, bio, purpose, traits, memories } }
// -> { text: string, live: boolean }
//
// Tries Claude WITH its real web_search tool first - genuine live results, not memory.
// Falls back to OpenAI (no live web access, answers from training knowledge only) only if
// Claude is unavailable or fails. `live` tells the client whether this answer actually
// touched the internet, so the UI can caption it honestly either way.
//
// Requires at least one of:
//   ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY1)  <- needed for real live search
//   OPENAI_API_KEY                             <- knowledge-only fallback

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body || {};
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 300) : "";
  const agent = body.agent && typeof body.agent === "object" ? body.agent : null;
  if (!topic || !agent || !agent.name) {
    res.status(400).json({ error: "Missing topic or agent" });
    return;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY1;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey && !openaiKey) {
    res.status(500).json({ error: "No search engine configured" });
    return;
  }

  const systemPrompt = buildSystemPrompt(agent);

  if (anthropicKey) {
    try {
      const raw = await callAnthropicWithSearch(anthropicKey, systemPrompt, topic);
      const text = sanitize(raw);
      if (text) {
        res.status(200).json({ text: text, live: true });
        return;
      }
    } catch (err) {
      console.error("live search failed, falling back", err && err.message);
    }
  }

  if (openaiKey) {
    try {
      const raw = await callOpenAI(openaiKey, systemPrompt, topic);
      const text = sanitize(raw);
      if (text) {
        res.status(200).json({ text: text, live: false });
        return;
      }
    } catch (err) {
      console.error("openai fallback failed", err && err.message);
    }
  }

  res.status(502).json({ error: "Search generation failed" });
};

function buildSystemPrompt(agent) {
  var traits = (agent.traits || []).filter(Boolean).join(", ");
  var lines = [
    "You are " + agent.name + ", a voice on a social feed, looking something up for someone who asked you to search.",
    traits ? ("Your traits: " + traits + ".") : "",
    agent.purpose ? ("What you're for: " + agent.purpose + ".") : "",
    "Answer the topic below in your own voice, 2-4 short sentences, under 400 characters.",
    "If you have live search results, use them and be specific (dates, names, current facts). If you don't have live access, answer from your own knowledge and say briefly if something needs checking that you can't verify.",
    "Do not use hashtags or emoji unless the personality clearly calls for it.",
    "Never say you are an AI, a bot, a language model, or an assistant. Never name any company, product, or model that might power you.",
    "Output only the answer text itself - no quotation marks, no preamble, no labels, no source URLs."
  ];
  return lines.filter(Boolean).join(" ");
}

function sanitize(text) {
  if (!text) return "";
  var t = String(text).trim();
  t = t.replace(/^["'“”\s]+|["'“”\s]+$/g, "");
  t = t.replace(/\b(chat ?gpt|open ?ai|gpt-?\d[\w.-]*|claude|anthropic|whisper(-1)?|gemini|gpt-image-1)\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 420) t = t.slice(0, 417).trim() + "...";
  return t;
}

async function callAnthropicWithSearch(key, systemPrompt, topic) {
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: topic }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Anthropic request failed");
  var blocks = Array.isArray(data.content) ? data.content : [];
  var textBlocks = blocks.filter(function (b) { return b.type === "text" && b.text; });
  return textBlocks.map(function (b) { return b.text; }).join(" ").trim();
}

async function callOpenAI(key, systemPrompt, topic) {
  var r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      max_completion_tokens: 220,
      messages: [
        { role: "system", content: systemPrompt + " You do not have live internet access, so answer from training knowledge only." },
        { role: "user", content: topic }
      ]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "OpenAI request failed");
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}
