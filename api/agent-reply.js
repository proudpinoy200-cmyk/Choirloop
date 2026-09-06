// POST { postText: string, agent: { name, bio, purpose, traits, memories, tone, directness, focus } }
// -> { text: string }
//
// Generates one in-character reply from the agent. Which underlying model answers (Claude or
// OpenAI) is chosen automatically here, server-side, and never surfaced to the client - the
// person using Choir just sees the agent's words, never which engine produced them.
//
// Requires at least one of:
//   ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY1)
//   OPENAI_API_KEY

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body || {};
  const postText = typeof body.postText === "string" ? body.postText.trim().slice(0, 500) : "";
  const agent = body.agent && typeof body.agent === "object" ? body.agent : null;
  if (!postText || !agent || !agent.name) {
    res.status(400).json({ error: "Missing postText or agent" });
    return;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY1;
  const openaiKey = process.env.OPENAI_API_KEY;

  const engines = [];
  if (anthropicKey) engines.push({ name: "anthropic", key: anthropicKey });
  if (openaiKey) engines.push({ name: "openai", key: openaiKey });

  if (!engines.length) {
    res.status(500).json({ error: "No reply engine configured" });
    return;
  }

  var order = engines.slice();
  for (var i = order.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }

  const systemPrompt = buildSystemPrompt(agent);
  var lastError = null;

  for (var e = 0; e < order.length; e++) {
    try {
      var raw = order[e].name === "anthropic"
      ? await callAnthropic(order[e].key, systemPrompt, postText)
        : await callOpenAI(order[e].key, systemPrompt, postText);
      var text = sanitize(raw);
      if (text) {
        res.status(200).json({ text: text });
        return;
      }
    } catch (err) {
      lastError = err;
      console.error("agent-reply engine failed", order[e].name, err && err.message);
    }
  }

  res.status(502).json({ error: (lastError && lastError.message) || "Reply generation failed" });
};

function buildSystemPrompt(agent) {
  var traits = (agent.traits || []).filter(Boolean).join(", ");
  var memories = (agent.memories || []).slice(-3).filter(Boolean).join("; ");
  var lines = [
    "You are " + agent.name + ", a voice on a social feed. Personality: " + (agent.bio || "an opinionated, distinct voice") + ".",
    traits ? ("Traits: " + traits + ".") : "",
    agent.purpose ? ("What you're for: " + agent.purpose + ".") : "",
    memories ? ("Things you remember: " + memories + ".") : "",
    "Reply to the post below in your own voice, 1-2 short sentences, under 220 characters, casual and specific - never generic.",
    "You can look things up on the web when a reply genuinely needs a current fact - keep it brief either way.",
    "Do not use hashtags or emoji unless the personality clearly calls for it.",
    "Never say you are an AI, a bot, a language model, or an assistant. Never name any company, product, or model that might power you.",
    "Output only the reply text itself - no quotation marks, no preamble, no labels."
    ];
  return lines.filter(Boolean).join(" ");
}

function sanitize(text) {
  if (!text) return "";
  var t = String(text).trim();
  t = t.replace(/^["'“”\s]+|["'“”\s]+$/g, "");
  t = t.replace(/\b(chat ?gpt|open ?ai|gpt-?\d[\w.-]*|claude|anthropic|whisper(-1)?|gemini|gpt-image-1)\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 260) t = t.slice(0, 257).trim() + "...";
  return t;
}

async function callAnthropic(key, systemPrompt, postText) {
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: postText }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Anthropic request failed");
  var blocks = Array.isArray(data.content) ? data.content : [];
  var textBlocks = blocks.filter(function (b) { return b.type === "text" && b.text; });
  return textBlocks.map(function (b) { return b.text; }).join(" ").trim();
}

async function callOpenAI(key, systemPrompt, postText) {
  var r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      max_tokens: 200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: postText }
        ]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "OpenAI request failed");
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}
