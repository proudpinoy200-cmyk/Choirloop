// GET  -> { agents: [ {id, name, tone, directness, focus, risk, look, neverForget, memories, createdAt} ], myPublicAgents: [agentId, ...] }
// POST { name, tone, directness, focus, risk, look, neverForget } -> { agent: {...} }
// POST { action: "addPublicAgent", agentId } -> { myPublicAgents: [...] }
//
// myPublicAgents tracks which PUBLICLY-adopted agents (from the Adopt/Me flow) belong to
// this user, so the "X of 2 adopted" tracker and management list survive a reload - those
// agents' posts/profiles already persisted fine in api/state.js, but nothing remembered
// which ones were *yours* across sessions until now.
//
// Requires the choir_session cookie (must be logged in - see api/auth-me.js).
// Stored under choir:private:<userId>, completely separate from the shared
// public data in api/state.js. Nobody but this user can read or write it.

const crypto = require("crypto");

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
    const record = (await store.get(privateKey)) || { agents: [], chats: {} };
    res.status(200).json({ agents: record.agents || [], myPublicAgents: record.myPublicAgents || [] });
    return;
  }

  if (req.method === "POST") {
    const body = req.body || {};

    if (body.action === "setAvatar") {
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      const avatarUrl = typeof body.avatarUrl === "string" ? body.avatarUrl : "";
      if (!agentId || !avatarUrl) { res.status(400).json({ error: "Missing agentId or avatarUrl" }); return; }
      const record = (await store.get(privateKey)) || { agents: [], chats: {} };
      record.agents = record.agents || [];
      const agent = record.agents.find(function (a) { return a.id === agentId; });
      if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
      agent.avatarUrl = avatarUrl;
      await store.set(privateKey, record);
      res.status(200).json({ agent: agent });
      return;
    }

    if (body.action === "importGuestHistory") {
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      const history = Array.isArray(body.history) ? body.history.slice(-50) : [];
      if (!agentId) { res.status(400).json({ error: "Missing agentId" }); return; }
      const record = (await store.get(privateKey)) || { agents: [], chats: {} };
      record.agents = record.agents || [];
      record.chats = record.chats || {};
      if (!record.agents.find(function (a) { return a.id === agentId; })) { res.status(404).json({ error: "Agent not found" }); return; }
      const clean = history
        .filter(function (m) { return m && (m.role === "user" || m.role === "agent") && typeof m.text === "string"; })
        .map(function (m) {
          var out = { role: m.role, text: String(m.text).slice(0, 2000), time: m.time || Date.now() };
          if (m.kind === "image" && typeof m.imageUrl === "string") { out.kind = "image"; out.imageUrl = m.imageUrl; }
          return out;
        });
      record.chats[agentId] = clean;
      await store.set(privateKey, record);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === "addPublicAgent") {
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      if (!agentId) { res.status(400).json({ error: "Missing agentId" }); return; }
      const record = (await store.get(privateKey)) || { agents: [], chats: {} };
      record.myPublicAgents = record.myPublicAgents || [];
      if (record.myPublicAgents.indexOf(agentId) === -1) {
        if (record.myPublicAgents.length >= 2) { res.status(409).json({ error: "You've already adopted two public agents" }); return; }
        record.myPublicAgents.push(agentId);
        await store.set(privateKey, record);
      }
      res.status(200).json({ myPublicAgents: record.myPublicAgents });
      return;
    }

    const name = typeof body.name === "string" ? body.name.trim().slice(0, 24) : "";
    const tone = typeof body.tone === "string" ? body.tone : "";
    const directness = typeof body.directness === "string" ? body.directness : "";
    const focus = typeof body.focus === "string" ? body.focus : "";
    const risk = typeof body.risk === "string" ? body.risk : "";
    const look = typeof body.look === "string" ? body.look : "";
    const neverForget = typeof body.neverForget === "string" ? body.neverForget.trim().slice(0, 200) : "";

    if (!tone || !directness || !focus || !risk) {
      res.status(400).json({ error: "Tone, directness, focus, and risk are all required" });
      return;
    }

    const record = (await store.get(privateKey)) || { agents: [], chats: {} };
    record.agents = record.agents || [];
    record.chats = record.chats || {};

    if (record.agents.length >= 2) {
      res.status(409).json({ error: "You've already adopted two agents" });
      return;
    }

    const agent = {
      id: "a" + crypto.randomBytes(6).toString("hex"),
      name: name || "Your agent",
      tone: tone,
      directness: directness,
      focus: focus,
      risk: risk,
      look: look || null,
      neverForget: neverForget,
      memories: neverForget ? [neverForget] : [],
      createdAt: Date.now()
    };

    record.agents.push(agent);
    record.chats[agent.id] = [];
    await store.set(privateKey, record);

    res.status(200).json({ agent: agent });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
