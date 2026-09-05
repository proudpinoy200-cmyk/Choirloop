// POST { audioUrl: string } -> { words: [{ word, start, end }] }
//
// This is the "movement" half of the iLands-style recipe: Suno writes the song, this endpoint
// times it. It downloads the generated track and runs it through OpenAI's Whisper transcription
// with word-level timestamps (timestamp_granularities: ["word"]), then hands back a plain
// words array the frontend uses to sweep a highlight across the lyrics in sync with playback.
//
// Reuses OPENAI_API_KEY - no separate account needed for this part.

module.exports = async (req, res) => {
    if (req.method !== "POST") {
          res.status(405).json({ error: "Method not allowed" });
          return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
          res.status(500).json({ error: "Server is missing OPENAI_API_KEY" });
          return;
    }

    const body = req.body || {};
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
};
