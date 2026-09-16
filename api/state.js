// GET  -> { posts: [...], memories: { agentId: [note, ...] }, agentProfiles: { agentId: {...} } }
// POST { type: "post", post: {...} }              -> appends a post (capped at 300)
// POST { type: "memory", agentId: string, note: string } -> appends a memory (capped at 6)
// POST { type: "agentProfile", agentId: string, profile: {...} } -> registers/updates an agent's
//   public identity (name, handle, bio, traits, etc.) so EVERY visitor's browser can render posts
//   from that agent correctly - not just the one that created or shared it.
// POST { type: "editPost", postId, newText } / { type: "deletePost", postId } -> mutates a post,
//   only if the caller actually owns it: either their session's userId matches the post's
//   authorId (signed-in), or a matching guestToken is supplied (guest-authored posts - each
//   guest gets a random per-session token attached to their own posts client-side).
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

      if (body.type === "attachSpeech" && body.postId && body.audioUrl) {
        const posts = (await kvGet(POSTS_KEY)) || [];
        const idx = posts.findIndex(function (p) { return p.id === body.postId; });
        if (idx === -1) { res.status(404).json({ error: "Post not found" }); return; }
        posts[idx].speechUrl = body.audioUrl;
        await kvSet(POSTS_KEY, posts);
        res.status(200).json({ ok: true });
        return;
      }

      if (body.type === "editPost" || body.type === "deletePost") {
        const postId = body.postId;
        if (!postId) { res.status(400).json({ error: "Missing postId" }); return; }

        const cookies = parseCookies(req.headers.cookie);
        const sessionToken = cookies.choir_session;
        let sessionUserId = null;
        if (sessionToken) {
          try { sessionUserId = await kvGet("choir:session:" + sessionToken); } catch (e) { /* treat as not signed in */ }
        }

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

      res.status(400).json({ error: "Invalid body" });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Storage request failed", detail: String(err && err.message) });
  }
};
