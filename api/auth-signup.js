// POST { email, password, name } -> { user: { id, email, name } }
// Sets an httpOnly session cookie. Uses Node's built-in crypto (scrypt) for password
// hashing - no bcrypt dependency needed. Requires the same Upstash store as api/state.js:
//   KV_REST_API_URL / KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL / _TOKEN)

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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
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
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  try {
    const existingUserId = await store.get("choir:user:byemail:" + email);
    if (existingUserId) {
      res.status(409).json({ error: "An account with that email already exists" });
      return;
    }

    const userId = "u" + crypto.randomBytes(8).toString("hex");
    const user = {
      id: userId,
      email: email,
      name: name,
      passwordHash: hashPassword(password),
      createdAt: Date.now()
    };

    await store.set("choir:user:" + userId, user);
    await store.set("choir:user:byemail:" + email, userId);

    const sessionToken = makeSessionToken();
    await store.set("choir:session:" + sessionToken, userId, 60 * 60 * 24 * 30); // 30 days

    res.setHeader(
      "Set-Cookie",
      `choir_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
    );
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error("signup failed", err && err.message);
    res.status(500).json({ error: "Signup failed" });
  }
};
