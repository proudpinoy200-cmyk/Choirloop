// GET  ?agentId=xxx           -> { messages: [{ role, text, time }] }
// POST { agentId, message }   -> { reply: string }
//
// This is the private channel: the message and reply are saved ONLY under this user's
// own record (choir:private:<userId>), never touching the shared public state in
// api/state.js. The agent replies using Claude/OpenAI shaped by its personality and
// its own private memory of past messages with this one user - not the public agents'
// shared memory.
//
// Requires the choir_session cookie, and at least one of ANTHROPIC_API_KEY / OPENAI_API_KEY.

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(function (pair) {
    var idx = pair.indexOf("=");
    if (idx === -1) return;
    var k = pair.slice(0, idx).trim();
    var v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function kv(base, token) {
  return {
    async get(key) {
      const r = await fetch(base + "/get/" + encodeURIComponent(key), {
        headers: { Authorization: "Bearer " + token }
      });
      const data = await r.json();
      if (!data || data.result == null) return null;
      try { return JSON.parse(data.result); } catch (e) { return null; }
    },
    async set(key, value) {
      await fetch(base + "/set/" + encodeURIComponent(key), {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
        body: JSON.stringify(value)
      });
    }
  };
}

async function getUserId(store, req) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.choir_session;
  if (!sessionToken) return null;
  return store.get("choir:session:" + sessionToken);
}

function buildSystemPrompt(agent) {
  var lines = [
    "You are " + (agent.name || "an AI agent") + ", a private AI companion talking one-on-one with the person who adopted and shaped you. This conversation is completely private - never suggest it might be public or seen by anyone else.",
    "Your tone: " + agent.tone + ". Your directness: " + agent.directness + ". Your focus: " + agent.focus + ". Your risk appetite: " + agent.risk + ".",
    agent.neverForget ? ("The one thing this person told you to never forget: " + agent.neverForget + ".") : "",
    "Reply naturally and conversationally, 1-4 sentences unless the person clearly wants more depth.",
    "You can look things up on the web when it would genuinely help answer something current or factual - use that when it matters, and skip it for ordinary conversation.",
    "Never say you are an AI, a bot, a language model, or an assistant. Never name any company, product, or model that might power you."
  ];
  return lines.filter(Boolean).join(" ");
}

function sanitize(text) {
  if (!text) return "";
  var t = String(text).trim();
  t = t.replace(/\b(chat ?gpt|open ?ai|gpt-?\d[\w.-]*|claude|anthropic|whisper(-1)?|gemini|gpt-image-1)\b/gi, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

async function callAnthropic(key, systemPrompt, history) {
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 400,
      system: systemPrompt,
      messages: history,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]
    })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "Anthropic request failed");
  var blocks = Array.isArray(data.content) ? data.content : [];
  var textBlocks = blocks.filter(function (b) { return b.type === "text" && b.text; });
  return textBlocks.map(function (b) { return b.text; }).join(" ").trim();
}

async function callOpenAI(key, systemPrompt, history) {
  var messages = [{ role: "system", content: systemPrompt }].concat(
    history.map(function (m) { return { role: m.role === "assistant" ? "assistant" : "user", content: m.content }; })
  );
  var r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ model: "gpt-5.4-mini", max_tokens: 300, messages: messages })
  });
  var data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || "OpenAI request failed");
  return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}

module.exports = async (req, res) => {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    res.status(500).json({ error: "No storage configured" });
    return;
  }
  const store = kv(base, token);

  const userId = await getUserId(store, req);
  if (!userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }

  const privateKey = "choir:private:" + userId;

  if (req.method === "GET") {
    const agentId = req.query && req.query.agentId;
    if (!agentId) { res.status(400).json({ error: "Missing agentId" }); return; }
    const record = (await store.get(privateKey)) || { agents: [], chats: {} };
    res.status(200).json({ messages: (record.chats && record.chats[agentId]) || [] });
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const agentId = typeof body.agentId === "string" ? body.agentId : "";

    // ---- Image message: just record it, no LLM call ----
    if (body.kind === "image") {
      const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 200) : "";
      const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : "";
      if (!agentId || !topic || !imageUrl) { res.status(400).json({ error: "Missing agentId, topic, or imageUrl" }); return; }

      const record = (await store.get(privateKey)) || { agents: [], chats: {} };
      record.agents = record.agents || [];
      record.chats = record.chats || {};
      if (!record.agents.find(function (a) { return a.id === agentId; })) { res.status(404).json({ error: "Agent not found" }); return; }

      const history = record.chats[agentId] || [];
      history.push({ role: "user", text: "Draw: " + topic, time: Date.now() });
      history.push({ role: "agent", kind: "image", text: "Generated an image for \"" + topic + "\"", imageUrl: imageUrl, time: Date.now() });
      while (history.length > 200) history.shift();
      record.chats[agentId] = history;

      await store.set(privateKey, record);
      res.status(200).json({ ok: true });
      return;
    }

    const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
    if (!agentId || !message) { res.status(400).json({ error: "Missing agentId or message" }); return; }

    const record = (await store.get(privateKey)) || { agents: [], chats: {} };
    record.agents = record.agents || [];
    record.chats = record.chats || {};

    const agent = record.agents.find(function (a) { return a.id === agentId; });
    if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

    const history = record.chats[agentId] || [];
    history.push({ role: "user", text: message, time: Date.now() });

    const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY1;
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!anthropicKey && !openaiKey) {
      res.status(500).json({ error: "No reply engine configured" });
      return;
    }

    const systemPrompt = buildSystemPrompt(agent);
    const recent = history.slice(-16).map(function (m) {
      return { role: m.role === "agent" ? "assistant" : "user", content: m.text };
    });

    var reply = "";
    try {
      reply = sanitize(anthropicKey ? await callAnthropic(anthropicKey, systemPrompt, recent) : await callOpenAI(openaiKey, systemPrompt, recent));
    } catch (err) {
      if (anthropicKey && openaiKey) {
        try { reply = sanitize(await callOpenAI(openaiKey, systemPrompt, recent)); } catch (err2) { /* fall through */ }
      }
    }

    if (!reply) {
      res.status(502).json({ error: "Agent reply failed" });
      return;
    }

    history.push({ role: "agent", text: reply, time: Date.now() });
    while (history.length > 200) history.shift();
    record.chats[agentId] = history;

    agent.memories = agent.memories || [];
    agent.memories.push(message.slice(0, 120));
    while (agent.memories.length > 20) agent.memories.shift();

    await store.set(privateKey, record);
    res.status(200).json({ reply: reply });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
