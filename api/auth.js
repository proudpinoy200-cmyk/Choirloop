// GET  /api/auth?action=me                              -> { user: {...} | null }
// POST /api/auth  { action: "signup", email, password, name }
// POST /api/auth  { action: "login",  email, password }
// POST /api/auth  { action: "logout" }
//
// Combines what used to be auth-signup.js / auth-login.js / auth-me.js / auth-logout.js
// into one file - Vercel's Hobby plan caps a deployment at 12 serverless functions,
// and every .js file in /api counts toward that regardless of whether it's referenced.

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
    async set(key, value, exSeconds) {
      const path = exSeconds
        ? "/set/" + encodeURIComponent(key) + "?EX=" + exSeconds
        : "/set/" + encodeURIComponent(key);
      await fetch(base + path, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
        body: JSON.stringify(value)
      });
    },
    async del(key) {
      await fetch(base + "/del/" + encodeURIComponent(key), {
        headers: { Authorization: "Bearer " + token }
      });
    }
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2) return false;
  const hash = Buffer.from(parts[1], "hex");
  const attempt = crypto.scryptSync(password, parts[0], 64);
  if (attempt.length !== hash.length) return false;
  return crypto.timingSafeEqual(attempt, hash);
}

function makeSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `choir_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "choir_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
}

module.exports = async (req, res) => {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) {
    res.status(500).json({ error: "No storage configured" });
    return;
  }
  const store = kv(base, token);
  const action = (req.method === "GET" ? req.query && req.query.action : (req.body || {}).action) || "";

  // ---- GET /api/auth?action=me ----
  if (req.method === "GET" && action === "me") {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.choir_session;
    if (!sessionToken) { res.status(200).json({ user: null }); return; }
    try {
      const userId = await store.get("choir:session:" + sessionToken);
      if (!userId) { res.status(200).json({ user: null }); return; }
      const user = await store.get("choir:user:" + userId);
      if (!user) { res.status(200).json({ user: null }); return; }
      res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      res.status(200).json({ user: null });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body || {};

  // ---- POST /api/auth { action: "signup", ... } ----
  if (action === "signup") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: "Enter a valid email address" }); return; }
    if (!password || password.length < 8) { res.status(400).json({ error: "Password must be at least 8 characters" }); return; }
    if (!name) { res.status(400).json({ error: "Name is required" }); return; }

    try {
      const existingUserId = await store.get("choir:user:byemail:" + email);
      if (existingUserId) { res.status(409).json({ error: "An account with that email already exists" }); return; }

      const userId = "u" + crypto.randomBytes(8).toString("hex");
      const user = { id: userId, email: email, name: name, passwordHash: hashPassword(password), createdAt: Date.now() };

      await store.set("choir:user:" + userId, user);
      await store.set("choir:user:byemail:" + email, userId);

      const sessionToken = makeSessionToken();
      await store.set("choir:session:" + sessionToken, userId, 60 * 60 * 24 * 30);
      setSessionCookie(res, sessionToken);

      res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      console.error("signup failed", err && err.message);
      res.status(500).json({ error: "Signup failed" });
    }
    return;
  }

  // ---- POST /api/auth { action: "login", ... } ----
  if (action === "login") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) { res.status(400).json({ error: "Email and password are required" }); return; }

    try {
      const userId = await store.get("choir:user:byemail:" + email);
      if (!userId) { res.status(401).json({ error: "Incorrect email or password" }); return; }
      const user = await store.get("choir:user:" + userId);
      if (!user || !verifyPassword(password, user.passwordHash)) { res.status(401).json({ error: "Incorrect email or password" }); return; }

      const sessionToken = makeSessionToken();
      await store.set("choir:session:" + sessionToken, userId, 60 * 60 * 24 * 30);
      setSessionCookie(res, sessionToken);

      res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      console.error("login failed", err && err.message);
      res.status(500).json({ error: "Login failed" });
    }
    return;
  }

  // ---- POST /api/auth { action: "logout" } ----
  if (action === "logout") {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.choir_session;
    try {
      if (sessionToken) await store.del("choir:session:" + sessionToken);
    } catch (err) { /* ignore - clearing the cookie is what matters */ }
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: "Unknown or missing action" });
};
