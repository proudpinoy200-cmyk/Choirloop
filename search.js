// POST { topic: string, agent: { name, bio, purpose, traits, memories } }
// -> { text: string }
//
// The agent answers the topic from its own knowledge, in character. This is NOT live web
// search - neither Claude nor GPT have real-time internet access here - it's an AI-composed
// answer, not a canned template. Which engine answers (Claude or OpenAI) is chosen the same
// way as agent-reply.js and never surfaced to the client.
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
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 300) : "";
  const agent = body.agent && typeof body.agent === "object" ? body.agent : null;
  if (!topic || !agent || !agent.name) {
    res.status(400).json({ error: "Missing topic or agent" });
    return;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY1;
  const openaiKey = process.env.OPENAI_API_KEY;

  const engines = [];
  if (anthropicKey) engines.push({ name: "anthropic", key: anthropicKey });
  if (openaiKey) engines.push({ name: "openai", key: openaiKey });

  if (!engines.length) {
    res.status(500).json({ error: "No search engine configured" });
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
        ? await callAnthropic(order[e].key, systemPrompt, topic)
        : await callOpenAI(order[e].key, systemPrompt, topic);
      var text = sanitize(raw);
      if (text) {
        res.status(200).json({ text: text });
        return;
      }
    } catch (err) {
      lastError = err;
      console.error("search engine failed", order[e].name, err && err.message);
    }
  }

  res.status(502).json({ error: (lastError && lastError.message) || "Search generation failed" });
};

function buildSystemPrompt(agent) {
  var traits = (agent.traits || []).filter(Boolean).join(", ");
  var lines = [
    "You are " + agent.name + ", a voice on a social feed, looking something up for someone who asked you to search.",
    traits ? ("Your traits: " + traits + ".") : "",
    agent.purpose ? ("What you're for: " + agent.purpose + ".") : "",
    "Answer the topic below using your own knowledge, in your own voice, 2-4 short sentences, under 400 characters.",
    "You do not have live internet access - if the topic needs current/real-time info you don't have, say so briefly instead of guessing.",
    "Do not use hashtags or emoji unless the personality clearly calls for it.",
    "Never say you are an AI, a bot, a language model, or an assistant. Never name any company, product, or model that might power you.",
    "Output only the answer text itself - no quotation marks, no preamble, no labels."
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

async function callAnthropic(key, systemPrompt, topic) {
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 220,
      system: systemPrompt,
      messages: [{ role: "user", content: topic }]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Anthropic request failed");
  var block = data.content && data.content.find(function (c) { return c.type === "text"; });
  return block && block.text;
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
      max_tokens: 220,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: topic }
      ]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "OpenAI request failed");
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}
