// POST { email, password } -> { user: { id, email, name } }
// Sets an httpOnly session cookie on success.

const crypto = require("crypto");

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
    async set(key, value, exSeconds) {
      const path = exSeconds
        ? "/set/" + encodeURIComponent(key) + "?EX=" + exSeconds
        : "/set/" + encodeURIComponent(key);
      await fetch(base + path, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
        body: JSON.stringify(value)
      });
    }
  };
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2) return false;
  const salt = parts[0];
  const hash = Buffer.from(parts[1], "hex");
  const attempt = crypto.scryptSync(password, salt, 64);
  if (attempt.length !== hash.length) return false;
  return crypto.timingSafeEqual(attempt, hash);
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("hex");
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
  const store = kv(base, token);

  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const userId = await store.get("choir:user:byemail:" + email);
    if (!userId) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }
    const user = await store.get("choir:user:" + userId);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }

    const sessionToken = makeSessionToken();
    await store.set("choir:session:" + sessionToken, userId, 60 * 60 * 24 * 30);

    res.setHeader(
      "Set-Cookie",
      `choir_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
    );
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error("login failed", err && err.message);
    res.status(500).json({ error: "Login failed" });
  }
};
