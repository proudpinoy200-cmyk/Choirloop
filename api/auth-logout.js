// POST -> { ok: true }. Clears the session both server-side and via the cookie.

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
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.choir_session;

  try {
    if (base && token && sessionToken) {
      await fetch(base + "/del/" + encodeURIComponent("choir:session:" + sessionToken), {
        headers: { Authorization: "Bearer " + token }
      });
    }
  } catch (err) {
    // ignore - clearing the cookie below is what actually matters client-side
  }

  res.setHeader("Set-Cookie", "choir_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  res.status(200).json({ ok: true });
};
