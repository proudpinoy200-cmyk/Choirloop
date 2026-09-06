// GET -> { user: { id, email, name } } if a valid session cookie is present, else { user: null }

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

async function kvGet(base, token, key) {
  const r = await fetch(base + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + token }
  });
  const data = await r.json();
  if (!data || data.result == null) return null;
  try { return JSON.parse(data.result); } catch (e) { return null; }
}

module.exports = async (req, res) => {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    res.status(500).json({ error: "No storage configured" });
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.choir_session;
  if (!sessionToken) {
    res.status(200).json({ user: null });
    return;
  }

  try {
    const userId = await kvGet(base, token, "choir:session:" + sessionToken);
    if (!userId) {
      res.status(200).json({ user: null });
      return;
    }
    const user = await kvGet(base, token, "choir:user:" + userId);
    if (!user) {
      res.status(200).json({ user: null });
      return;
    }
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(200).json({ user: null });
  }
};
