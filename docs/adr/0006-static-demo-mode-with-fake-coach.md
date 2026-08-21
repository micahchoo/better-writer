# Static demo mode with a fake coach

The app ships a client-only build for GitHub Pages: no server, no local model, no STT. In that build the coach is a fake — it skips the model and shows a randomly pulled seed `question` verbatim, with seeds bundled as client JSON. Persistence falls back to the browser (localStorage); dictation is absent. The coach's ask sits behind a seam with two implementations: static (random pull) and local (server model reshape, gated).
