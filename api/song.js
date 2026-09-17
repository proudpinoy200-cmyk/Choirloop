// POST { }                        -> generate: { prompt } -> { audioUrl } or { id } to poll
// GET  ?id=CLIP_ID                 -> status: { audioUrl } once ready, { failed: true }, or {} (pending)
// POST { action: "transcribe", audioUrl } -> word-level timestamps for lyric sync
//
// Consolidates what used to be generate-song.js / song-status.js / transcribe-song.js into one
// file - same technique as api/auth.js - to stay under Vercel Hobby's 12-function-per-deployment
// cap while adding new features.
//
// Suno has no public API. Generation/status call whatever unofficial wrapper you point them at -
// e.g. a self-hosted https://github.com/gcui-art/suno-api or a paid third-party aggregator.
// Requires SUNO_API_BASE_URL / SUNO_API_KEY for generate+status, OPENAI_API_KEY for transcribe
// (reuses the same key already used elsewhere - no separate account needed).

async function checkUsageCap(reqHeaders) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return { ok: true };

  const GLOBAL_DAILY_CAP = 300;
  const USER_DAILY_CAP = 3;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const globalRes = await fetch(base + "/incr/" + encodeURIComponent("choir:usage:global:" + today), {
      method: "POST",
      headers: { Authorization: "Bearer " + token }
    });
    const globalData = await globalRes.json();
    if ((globalData.result || 0) > GLOBAL_DAILY_CAP) {
      return { ok: false, reason: "Choir's shared daily creative budget is used up for today \u2014 check back tomorrow." };
    }

    const cookies = {};
    (reqHeaders.cookie || "").split(";").forEach(function (pair) {
      var idx = pair.indexOf("=");
      if (idx === -1) return;
      cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    const sessionToken = cookies.choir_session;
    if (sessionToken) {
      const userIdRes = await fetch(base + "/get/" + encodeURIComponent("choir:session:" + sessionToken), {
        headers: { Authorization: "Bearer " + token }
      });
      const userIdData = await userIdRes.json();
      let userId = null;
      if (userIdData && userIdData.result != null) {
        try { userId = JSON.parse(userIdData.result); } catch (e) { userId = null; }
      }
      if (userId) {
        const userRes = await fetch(base + "/incr/" + encodeURIComponent("choir:usage:user:" + userId + ":" + today), {
          method: "POST",
          headers: { Authorization: "Bearer " + token }
        });
        const userData = await userRes.json();
        if ((userData.result || 0) > USER_DAILY_CAP) {
          return { ok: false, reason: "You've hit today's limit for images, songs, and voice (3/day) \u2014 resets tomorrow." };
        }
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("Usage cap check failed, allowing through", e && e.message);
    return { ok: true };
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return handleStatus(req, res);
  }
  if (req.method === "POST") {
    const body = req.body || {};
    if (body.action === "transcribe") {
      return handleTranscribe(req, res, body);
    }
    const capCheck = await checkUsageCap(req.headers);
    if (!capCheck.ok) {
      res.status(429).json({ error: capCheck.reason });
      return;
    }
    return handleGenerate(req, res, body);
  }
  res.status(405).json({ error: "Method not allowed" });
};

async function handleGenerate(req, res, body) {
  const base = process.env.SUNO_API_BASE_URL;
  const key = process.env.SUNO_API_KEY;
  if (!base || !key) {
    res.status(500).json({ error: "Server is missing SUNO_API_BASE_URL or SUNO_API_KEY" });
    return;
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 400) : "";
  if (!prompt) {
    res.status(400).json({ error: "Missing prompt" });
    return;
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        prompt: prompt,
        make_instrumental: false,
        wait_audio: false
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const message = (data && (data.error || data.message)) || "Song generation failed";
      console.error("Suno wrapper generate failed", upstream.status, JSON.stringify(data));
      res.status(upstream.status).json({ error: message });
      return;
    }

    const clip = Array.isArray(data) ? data[0] : (data && data.data && data.data[0]) || data;
    const audioUrl = clip && (clip.audio_url || clip.audioUrl);
    const id = clip && (clip.id || clip.clip_id);

    if (audioUrl) {
      res.status(200).json({ audioUrl: audioUrl, title: clip.title || null });
      return;
    }
    if (id) {
      res.status(202).json({ id: id });
      return;
    }
    res.status(502).json({ error: "Unrecognized response from Suno wrapper" });
  } catch (err) {
    res.status(500).json({ error: "Request to Suno wrapper failed" });
  }
}

async function handleStatus(req, res) {
  const base = process.env.SUNO_API_BASE_URL;
  const key = process.env.SUNO_API_KEY;
  if (!base || !key) {
    res.status(500).json({ error: "Server is missing SUNO_API_BASE_URL or SUNO_API_KEY" });
    return;
  }

  const id = req.query && req.query.id;
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }

  try {
    const upstream = await fetch(`${base.replace(/\/$/, "")}/api/get?ids=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(200).json({}); // treat as still-pending rather than hard-fail mid-poll
      return;
    }

    const clip = Array.isArray(data) ? data[0] : data;
    if (!clip) { res.status(200).json({}); return; }

    if (clip.status === "error" || clip.status === "failed") {
      res.status(200).json({ failed: true });
      return;
    }

    const audioUrl = clip.audio_url || clip.audioUrl;
    if (audioUrl) {
      res.status(200).json({ audioUrl: audioUrl, title: clip.title || null });
      return;
    }

    res.status(200).json({}); // still rendering
  } catch (err) {
    res.status(200).json({}); // transient error - let the poll loop retry
  }
}

async function handleTranscribe(req, res, body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing OPENAI_API_KEY" });
    return;
  }

  const audioUrl = typeof body.audioUrl === "string" ? body.audioUrl : "";
  if (!audioUrl) {
    res.status(400).json({ error: "Missing audioUrl" });
    return;
  }

  try {
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      res.status(502).json({ error: "Could not download generated audio" });
      return;
    }
    const arrayBuffer = await audioResp.arrayBuffer();
    const audioBlob = new Blob([arrayBuffer], { type: "audio/mpeg" });

    const form = new FormData();
    form.append("file", audioBlob, "song.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");

    const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const message = (data && data.error && data.error.message) || "Transcription failed";
      console.error("Whisper transcription failed", upstream.status, JSON.stringify(data));
      res.status(upstream.status).json({ error: message });
      return;
    }

    const words = (data.words || []).map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end
    }));

    res.status(200).json({ words });
  } catch (err) {
    res.status(500).json({ error: "Transcription request failed" });
  }
}
