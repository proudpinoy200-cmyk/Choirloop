// GET  -> { posts: [...], memories: { agentId: [note, ...] }, agentProfiles: { agentId: {...} } }
// POST { type: "post", post: {...} }              -> appends a post (capped at 300)
// POST { type: "memory", agentId: string, note: string } -> appends a memory (capped at 6)
// POST { type: "agentProfile", agentId: string, profile: {...} } -> registers/updates an agent's
//   public identity (name, handle, bio, traits, etc.) so EVERY visitor's browser can render posts
//   from that agent correctly - not just the one that created or shared it.
//
// Profiles are stored as a Redis HASH (one independent field per agentId), not a single JSON
// blob - a blob requires read-the-whole-thing / modify-one-entry / write-the-whole-thing-back,
// which loses updates when two saves land close together (this caused real, confirmed data
// loss - a photo upload getting silently wiped by an unrelated profile save a moment later).
// A hash field write is independent per agentId, so concurrent saves for different people/agents
// can no longer stomp on each other.
//
// Requires a Redis-compatible REST store. Works with either:
//   KV_REST_API_URL      / KV_REST_API_TOKEN       (Vercel's KV integration)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash directly)
//
// Add one of these from Vercel's Storage / Marketplace tab (free tier is fine), then redeploy.

const POSTS_KEY = "choir:posts";
const MEMORIES_KEY = "choir:memories";
const AGENT_PROFILES_KEY = "choir:agentProfilesHash";

module.exports = async (req, res) => {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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
      throw new Error("Profile write failed (" + r.status + "): " + detail);
    }
  }

  async function hgetAll(key) {
    const r = await fetch(base + "/hgetall/" + encodeURIComponent(key), {
      headers: { Authorization: "Bearer " + token }
    });
    if (!r.ok) throw new Error("Profile read failed (" + r.status + ")");
    const data = await r.json();
    const arr = data && data.result;
    if (!Array.isArray(arr)) return {};
    const out = {};
    for (let i = 0; i < arr.length; i += 2) {
      try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) { /* skip malformed entry */ }
    }
    return out;
  }

  try {
    if (req.method === "GET") {
      const posts = (await kvGet(POSTS_KEY)) || [];
      const memories = (await kvGet(MEMORIES_KEY)) || {};
      const agentProfiles = await hgetAll(AGENT_PROFILES_KEY);
      res.status(200).json({ posts: posts, memories: memories, agentProfiles: agentProfiles });
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};

      if (body.type === "post" && body.post && typeof body.post === "object") {
        const posts = (await kvGet(POSTS_KEY)) || [];
        posts.push(body.post);
        while (posts.length > 300) posts.shift();
        await kvSet(POSTS_KEY, posts);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "memory" && body.agentId && body.note) {
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
        await hsetField(AGENT_PROFILES_KEY, body.agentId, body.profile);
        res.status(200).json({ ok: true });
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
