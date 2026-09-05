// GET /api/song-status?id=CLIP_ID -> { audioUrl } once ready, { failed: true } if Suno errored,
// or {} (still rendering) - the frontend polls this every ~6s.
//
// Same wrapper assumptions as generate-song.js: adjust the path/fields to match your provider.

module.exports = async (req, res) => {
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
                                                                                                                                      };
                                                                                                                                      
