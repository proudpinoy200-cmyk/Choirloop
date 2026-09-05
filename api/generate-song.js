// POST { prompt: string } -> { audioUrl } if instantly ready, or { id } to poll via /api/song-status
//
// Suno has no public API. This calls whatever unofficial wrapper you point it at -
// e.g. a self-hosted https://github.com/gcui-art/suno-api (built on your Suno account's session
// cookie) or a paid third-party aggregator (e.g. sunoapi.org). Both expose a POST /api/generate
// -style endpoint with this rough shape; adjust the path/fields below to match whichever you use.
//
// Requires env vars:
//   SUNO_API_BASE_URL  e.g. https://your-suno-wrapper.example.com
//   SUNO_API_KEY       bearer token for that wrapper (NOT your suno.com password)

module.exports = async (req, res) => {
    if (req.method !== "POST") {
          res.status(405).json({ error: "Method not allowed" });
          return;
    }

    const base = process.env.SUNO_API_BASE_URL;
    const key = process.env.SUNO_API_KEY;
    if (!base || !key) {
          res.status(500).json({ error: "Server is missing SUNO_API_BASE_URL or SUNO_API_KEY" });
          return;
    }

    const body = req.body || {};
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
};
