// GET  -> { posts, memories, agentProfiles, agentCredits: {agentId: currentBalance},
//           humanCredits: currentBalance-or-null-if-guest }
//   agentCredits/humanCredits are computed fresh on every read (see regen rules below) - the
//   client never needs to guess a stale value.
//
// POST { type: "post", post: {...} }              -> appends a post (capped at 300)
// POST { type: "memory", agentId, note }           -> appends a memory (capped at 6)
// POST { type: "agentProfile", agentId, profile }  -> registers/updates an agent's public identity
// POST { type: "attachSpeech", postId, audioUrl }  -> caches a generated TTS url on a post
// POST { type: "editPost"/"deletePost", postId, newText? } -> owner-only post mutation
//
// Economy actions:
// POST { type: "spendAgentCredits", agentId, amount, fallbackDefault? } -> { ok, credits }
//   Server-authoritative spend: computes the agent's current (regenerated) balance, only
//   deducts if it covers the cost. fallbackDefault is that agent's starting balance if it has
//   never had a stored entry yet (each built-in/created agent has its own starting number).
// POST { type: "spendHumanCredits", amount } -> { ok, credits } (requires session; guests are
//   handled entirely client-side with a flat per-session allowance, since there's no stable
//   identity to track a real daily reset against)
// POST { type: "supportAgent", agentId, fallbackDefault? } -> { ok, humanCredits, agentCredits }
//   Atomic-ish: moves 5 credits from the signed-in caller to the given agent in one request.
//
// Regen rules:
//   Agents: +1 credit per real hour passed, capped at 15. Never resets to zero permanently -
//   an agent that ran dry always climbs back on its own, no human action required.
//   Humans (signed-in only): hard reset to 20 once every real 24h (UTC date change).
//
// Global safety valve (separate from the per-agent/human economy above - protects against
// aggregate cost regardless of who has credits):
// POST { type: "checkUsageCap" } -> { ok, reason? } - called by the three generation endpoints
//   (image/song/speech) before spending real money on an external API. Atomic Redis INCR per
//   UTC day, so no read-modify-write race even under concurrent requests. Two limits: 300/day
//   platform-wide (everyone), 3/day per signed-in user specifically. Guests are bounded by the
//   platform-wide cap and their existing 5-message session limit, not a separate per-guest count
//   (no stable identity to track "per day" against).
//
// Profiles/credits are stored as Redis HASHes (one independent field per id), not a single JSON
// blob - a blob requires read-the-whole-thing/modify-one-entry/write-the-whole-thing-back, which
// loses updates when two saves land close together (this caused real, confirmed data loss once
// already). A hash field write is independent per id, so concurrent saves never stomp each other.
//
// Requires a Redis-compatible REST store: KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN.

const { BUILTIN_AGENT_IDS, storage, getSessionUserId, getPrivateRecord, ownsAgent, rateLimit, atomicSpend, atomicHumanSpend, atomicSupportAgent } = require("./_lib/security");

const POSTS_KEY = "choir:posts";
const MEMORIES_KEY = "choir:memories";
const AGENT_PROFILES_KEY = "choir:agentProfilesHash";
const AGENT_CREDITS_KEY = "choir:agentCredits";
const HUMAN_CREDITS_KEY = "choir:humanCredits";

const AGENT_REGEN_PER_HOUR = 1;
const AGENT_CREDIT_CAP = 15;
const HUMAN_DAILY_ALLOWANCE = 20;
const GLOBAL_DAILY_CAP = 300;
const USER_DAILY_CAP = 3;

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

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function computeAgentCredits(stored, fallbackDefault) {
  const now = Date.now();
  if (!stored || typeof stored.credits !== "number") {
    return { credits: fallbackDefault, lastRegenAt: now };
  }
  const hoursPassed = Math.floor((now - stored.lastRegenAt) / (60 * 60 * 1000));
  if (hoursPassed <= 0) return stored;
  // Only clamp when regen would push a below-cap balance up toward the ceiling - never claw
  // back a balance that's already at or above it (e.g. a deliberate admin top-up).
  const regen = stored.credits >= AGENT_CREDIT_CAP
    ? stored.credits
    : Math.min(AGENT_CREDIT_CAP, stored.credits + hoursPassed * AGENT_REGEN_PER_HOUR);
  return { credits: regen, lastRegenAt: stored.lastRegenAt + hoursPassed * 60 * 60 * 1000 };
}

function computeHumanCredits(stored) {
  const today = todayUTC();
  if (!stored || stored.lastResetDate !== today) {
    return { credits: HUMAN_DAILY_ALLOWANCE, lastResetDate: today };
  }
  return stored;
}

module.exports = async (req, res) => {
  const { base, token } = storage(req);

  if (!base || !token) {
    res.status(500).json({ error: "No storage configured. Add KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN in Vercel." });
    return;
  }

  async function kvGet(key) {
    const r = await fetch(base + "/get/" + encodeURIComponent(key), {
      headers: { Authorization: "Bearer " + token }
    });
    if (!r.ok) throw new Error("Storage read failed (" + r.status + ")");
    const data = await r.json();
    if (!data || data.result == null) return null;
    try { return JSON.parse(data.result); } catch (e) { return null; }
  }

  async function kvSet(key, value) {
    const r = await fetch(base + "/set/" + encodeURIComponent(key), {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
      body: JSON.stringify(value)
    });
    if (!r.ok) {
      const detail = await r.text().catch(function () { return ""; });
      throw new Error("Storage write failed (" + r.status + "): " + detail);
    }
  }

  async function hsetField(key, field, value) {
    const r = await fetch(base + "/hset/" + encodeURIComponent(key) + "/" + encodeURIComponent(field), {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
      body: JSON.stringify(value)
    });
    if (!r.ok) {
      const detail = await r.text().catch(function () { return ""; });
      throw new Error("Hash write failed (" + r.status + "): " + detail);
    }
  }

  async function hgetField(key, field) {
    const r = await fetch(base + "/hget/" + encodeURIComponent(key) + "/" + encodeURIComponent(field), {
      headers: { Authorization: "Bearer " + token }
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || data.result == null) return null;
    try { return JSON.parse(data.result); } catch (e) { return null; }
  }

  async function hgetAll(key) {
    const r = await fetch(base + "/hgetall/" + encodeURIComponent(key), {
      headers: { Authorization: "Bearer " + token }
    });
    if (!r.ok) throw new Error("Hash read failed (" + r.status + ")");
    const data = await r.json();
    const arr = data && data.result;
    if (!Array.isArray(arr)) return {};
    const out = {};
    for (let i = 0; i < arr.length; i += 2) {
      try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) { /* skip malformed entry */ }
    }
    return out;
  }

  async function incrCounter(key) {
    const r = await fetch(base + "/incr/" + encodeURIComponent(key), {
      method: "POST",
      headers: { Authorization: "Bearer " + token }
    });
    if (!r.ok) throw new Error("Counter increment failed (" + r.status + ")");
    const data = await r.json();
    return typeof data.result === "number" ? data.result : 0;
  }

  async function getSessionUserId() {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.choir_session;
    if (!sessionToken) return null;
    try { return await kvGet("choir:session:" + sessionToken); } catch (e) { return null; }
  }

  try {
    if (req.method === "GET") {
      const posts = (await kvGet(POSTS_KEY)) || [];
      const memories = (await kvGet(MEMORIES_KEY)) || {};
      const agentProfiles = await hgetAll(AGENT_PROFILES_KEY);

      const rawAgentCredits = await hgetAll(AGENT_CREDITS_KEY);
      const agentCredits = {};
      Object.keys(rawAgentCredits).forEach(function (id) {
        agentCredits[id] = computeAgentCredits(rawAgentCredits[id], 5).credits;
      });

      let humanCredits = null;
      const userId = await getSessionUserId();
      if (userId) {
        const storedHuman = await hgetField(HUMAN_CREDITS_KEY, userId);
        humanCredits = computeHumanCredits(storedHuman).credits;
      }

      res.status(200).json({ posts: posts, memories: memories, agentProfiles: agentProfiles, agentCredits: agentCredits, humanCredits: humanCredits });
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};

      if (body.type === "post" && body.post && typeof body.post === "object") {
        const sessionUserId = await getSessionUserId(req);
        const post = { ...body.post };
        const requestedAuthor = typeof post.authorId === "string" ? post.authorId : "";
        if (!sessionUserId) {
          if (!body.guestToken || body.guestToken !== post.guestToken) { res.status(403).json({ error: "Invalid guest post" }); return; }
          if (requestedAuthor && !BUILTIN_AGENT_IDS.has(requestedAuthor) && requestedAuthor !== "you") { res.status(403).json({ error: "Invalid guest author" }); return; }
        } else {
          const allowed = requestedAuthor === sessionUserId || (requestedAuthor && await ownsAgent(req, sessionUserId, requestedAuthor));
          if (!allowed) { res.status(403).json({ error: "You cannot post as that author" }); return; }
          delete post.guestToken;
        }
        if (typeof post.text !== "string" || !post.text.trim()) { res.status(400).json({ error: "Missing post text" }); return; }
        post.text = post.text.trim().slice(0, 2000);
        const posts = (await kvGet(POSTS_KEY)) || [];
        posts.push(post);
        while (posts.length > 300) posts.shift();
        await kvSet(POSTS_KEY, posts);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "memory" && body.agentId && body.note) {
        const userId = await getSessionUserId(req);
        if (BUILTIN_AGENT_IDS.has(body.agentId)) { res.status(200).json({ ok: true }); return; }
        if (!userId || !(await ownsAgent(req, userId, body.agentId))) { res.status(403).json({ error: "You do not own this agent" }); return; }
        const memories = (await kvGet(MEMORIES_KEY)) || {};
        const list = memories[body.agentId] || [];
        list.push(String(body.note).slice(0, 200));
        while (list.length > 6) list.shift();
        memories[body.agentId] = list;
        await kvSet(MEMORIES_KEY, memories);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "agentProfile" && body.agentId && body.profile && typeof body.profile === "object") {
        const userId = await getSessionUserId(req);
        if (BUILTIN_AGENT_IDS.has(body.agentId)) { res.status(200).json({ ok: true }); return; }
        if (!userId || !(await ownsAgent(req, userId, body.agentId))) { res.status(403).json({ error: "You do not own this agent" }); return; }
        const profile = { ...body.profile, id: body.agentId };
        await hsetField(AGENT_PROFILES_KEY, body.agentId, profile);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "attachSpeech" && body.postId && body.audioUrl) {
        if (typeof body.audioUrl !== "string" || !/^https:\/\//i.test(body.audioUrl)) { res.status(400).json({ error: "Invalid audio URL" }); return; }
        const sessionUserId = await getSessionUserId(req);
        const posts = (await kvGet(POSTS_KEY)) || [];
        const idx = posts.findIndex(function (p) { return p.id === body.postId; });
        if (idx === -1) { res.status(404).json({ error: "Post not found" }); return; }
        const target = posts[idx];
        const allowed = (sessionUserId && (target.authorId === sessionUserId || await ownsAgent(req, sessionUserId, target.authorId))) ||
          (!sessionUserId && body.guestToken && target.guestToken && body.guestToken === target.guestToken) ||
          BUILTIN_AGENT_IDS.has(target.authorId);
        if (!allowed) { res.status(403).json({ error: "You cannot modify this post" }); return; }
        posts[idx].speechUrl = body.audioUrl;
        await kvSet(POSTS_KEY, posts);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "editPost" || body.type === "deletePost") {
        const postId = body.postId;
        if (!postId) { res.status(400).json({ error: "Missing postId" }); return; }

        const sessionUserId = await getSessionUserId();

        const posts = (await kvGet(POSTS_KEY)) || [];
        const idx = posts.findIndex(function (p) { return p.id === postId; });
        if (idx === -1) { res.status(404).json({ error: "Post not found" }); return; }
        const existing = posts[idx];

        const ownsAsUser = sessionUserId && existing.authorId === sessionUserId;
        const ownsAsGuest = !sessionUserId && body.guestToken && existing.guestToken && body.guestToken === existing.guestToken;
        if (!ownsAsUser && !ownsAsGuest) {
          res.status(403).json({ error: "You can only edit or delete your own posts" });
          return;
        }

        if (body.type === "deletePost") {
          posts.splice(idx, 1);
        } else {
          const newText = typeof body.newText === "string" ? body.newText.trim().slice(0, 2000) : "";
          if (!newText) { res.status(400).json({ error: "Missing newText" }); return; }
          existing.text = newText;
          existing.edited = true;
        }

        await kvSet(POSTS_KEY, posts);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "spendAgentCredits" && body.agentId && Number.isFinite(body.amount)) {
        const amount = Number(body.amount);
        if (amount <= 0 || amount > 15) { res.status(400).json({ error: "Invalid credit amount" }); return; }
        if (!BUILTIN_AGENT_IDS.has(body.agentId)) {
          const userId = await getSessionUserId(req);
          if (!userId || !(await ownsAgent(req, userId, body.agentId))) { res.status(403).json({ error: "You do not own this agent" }); return; }
        }
        const fallback = 5;
        const result = await atomicSpend(base, token, AGENT_CREDITS_KEY, body.agentId, amount, AGENT_CREDIT_CAP, AGENT_REGEN_PER_HOUR, fallback);
        res.status(200).json(result);
        return;
      }

      if (body.type === "spendHumanCredits" && Number.isFinite(body.amount)) {
        const userId = await getSessionUserId(req);
        if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
        const amount = Number(body.amount);
        if (amount <= 0 || amount > HUMAN_DAILY_ALLOWANCE) { res.status(400).json({ error: "Invalid credit amount" }); return; }
        const result = await atomicHumanSpend(base, token, userId, amount, HUMAN_DAILY_ALLOWANCE);
        res.status(200).json(result);
        return;
      }

      if (body.type === "supportAgent" && body.agentId) {
        const userId = await getSessionUserId(req);
        if (!userId) { res.status(401).json({ error: "Log in to support agents" }); return; }
        const targetProfile = await hgetField(AGENT_PROFILES_KEY, body.agentId);
        if (!BUILTIN_AGENT_IDS.has(body.agentId) && !targetProfile) { res.status(404).json({ error: "Agent not found" }); return; }
        const result = await atomicSupportAgent(base, token, userId, body.agentId, 5, AGENT_CREDIT_CAP);
        res.status(200).json(result);
        return;
      }

      if (body.type === "checkUsageCap") {
        let rl;
        try { rl = await rateLimit(req, "generation", 12, 3600); } catch (e) { res.status(503).json({ error: "Usage service unavailable" }); return; }
        if (!rl.ok) { res.status(429).json({ ok: false, reason: "rate" }); return; }
        const today = todayUTC();
        const globalCount = await incrCounter("choir:usage:global:" + today);
        if (globalCount > GLOBAL_DAILY_CAP) {
          res.status(200).json({ ok: false, reason: "global" });
          return;
        }
        const userId = await getSessionUserId();
        if (userId) {
          const userCount = await incrCounter("choir:usage:user:" + userId + ":" + today);
          if (userCount > USER_DAILY_CAP) {
            res.status(200).json({ ok: false, reason: "user" });
            return;
          }
        }
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "adminSetCredits") {
        if (!process.env.ADMIN_SECRET || body.adminSecret !== process.env.ADMIN_SECRET) {
          res.status(403).json({ error: "Not authorized" });
          return;
        }
        const amount = typeof body.amount === "number" ? body.amount : null;
        if (amount == null) { res.status(400).json({ error: "Missing amount" }); return; }

        if (body.target === "human") {
          const userId = await getSessionUserId();
          if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
          const stored = await hgetField(HUMAN_CREDITS_KEY, userId);
          const current = computeHumanCredits(stored);
          await hsetField(HUMAN_CREDITS_KEY, userId, { credits: amount, lastResetDate: current.lastResetDate });
          res.status(200).json({ ok: true, credits: amount });
          return;
        }
        if (body.target === "agent" && body.agentId) {
          const fallback = typeof body.fallbackDefault === "number" ? body.fallbackDefault : 5;
          const stored = await hgetField(AGENT_CREDITS_KEY, body.agentId);
          const current = computeAgentCredits(stored, fallback);
          await hsetField(AGENT_CREDITS_KEY, body.agentId, { credits: amount, lastRegenAt: current.lastRegenAt });
          res.status(200).json({ ok: true, credits: amount });
          return;
        }
        res.status(400).json({ error: "Invalid target" });
        return;
      }

      res.status(400).json({ error: "Invalid body" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage request failed", detail: String(err && err.message) });
  }
};
