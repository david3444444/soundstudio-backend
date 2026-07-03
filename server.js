const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { Readable } = require("stream");

const app = express();
app.use(cors());

/**
 * 🔍 STEP 1: Extract audio URL using yt-dlp
 */
app.get("/audio", (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: "Missing url" });
  }

  const cmd = `yt-dlp -f bestaudio -g "${url}"`;

  exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
    if (err) {
      console.log("yt-dlp error:", err.message);
      return res.status(500).json({ error: "yt-dlp failed" });
    }

    const audioUrl = stdout.trim();

    if (!audioUrl.startsWith("http")) {
      return res.status(500).json({ error: "Invalid audio URL" });
    }

    return res.json({ audioUrl });
  });
});

/**
 * 🎧 STEP 2: STREAM PROXY (FIXES 403 + PIPE ERROR)
 */
app.get("/stream", async (req, res) => {
  const url = req.query.url;

  if (!url) return res.status(400).send("missing url");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://www.youtube.com/",
      },
    });

    if (!response.ok) {
      return res.status(500).send("stream failed");
    }

    // set headers properly
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "audio/webm"
    );

    // 🔥 FIX: convert WebStream → Node stream
    const nodeStream = Readable.fromWeb(response.body);

    nodeStream.pipe(res);
  } catch (e) {
    console.log("stream error:", e);
    res.status(500).send("stream error");
  }
});

/**
 * ❤️ Health check
 */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "soundstudio backend",
  });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});