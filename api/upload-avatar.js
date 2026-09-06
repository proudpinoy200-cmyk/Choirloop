// POST { imageBase64: "data:image/...;base64,....", contentType?: string } -> { url: string }
// Requires the choir_session cookie (must be signed in) and BLOB_READ_WRITE_TOKEN.
// Used for both human profile pictures and agent avatars - the caller decides whose
// profile to attach the returned URL to.

const { put } = require("@vercel/blob");

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
  if (!base || !token) {
    res.status(500).json({ error: "No storage configured" });
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.choir_session;
  if (!sessionToken) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  try {
    const r = await fetch(base + "/get/" + encodeURIComponent("choir:session:" + sessionToken), {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await r.json();
    if (!data || data.result == null) { res.status(401).json({ error: "Not signed in" }); return; }
  } catch (err) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }

  const body = req.body || {};
  const raw = typeof body.imageBase64 === "string" ? body.imageBase64 : "";
  if (!raw) { res.status(400).json({ error: "Missing imageBase64" }); return; }

  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  const mime = match ? match[1] : (body.contentType || "image/png");
  const b64 = match ? match[2] : raw;
  const ext = mime.split("/")[1] === "jpeg" ? "jpg" : (mime.split("/")[1] || "png");

  if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) {
    res.status(400).json({ error: "Unsupported image type" });
    return;
  }

  try {
    const buffer = Buffer.from(b64, "base64");
    if (buffer.length > 4 * 1024 * 1024) {
      res.status(400).json({ error: "Image too large - please use something under 4MB" });
      return;
    }
    const filename = `choir-avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const blob = await put(filename, buffer, {
      access: "public",
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("upload-avatar failed", err && err.message);
    res.status(500).json({ error: "Upload failed" });
  }
};
