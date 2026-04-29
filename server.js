const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");

const app = express();
const upload = multer({ dest: "uploads/" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
}));
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200);
});
app.use(express.json());

app.get("/", (req, res) => res.send("Backend is running 🚀"));

// ── SSE PROGRESS ─────────────────────────────────────────────────────────────
const clients = {};

app.get("/progress/:jobId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  clients[req.params.jobId] = res;
  req.on("close", () => delete clients[req.params.jobId]);
});

function sendProgress(jobId, percent, label) {
  if (clients[jobId]) {
    clients[jobId].write(`data: ${JSON.stringify({ percent, label })}\n\n`);
  }
}

// ── GENERATE ENDPOINT (Groq AI) ───────────────────────────────────────────────
app.post("/generate", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const jobId = req.body.jobId || Date.now().toString();
  const videoPath = path.resolve(req.file.path);
  const audioPath = videoPath + ".mp3";
  const translate = req.body.translate === "true";

  try {
    sendProgress(jobId, 10, "Extracting audio...");

    // ✅ FFmpeg se audio extract karo
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i", videoPath,
        "-vn",
        "-acodec", "mp3",
        "-y",
        audioPath
      ]);
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("FFmpeg audio extraction failed"));
      });
    });

    sendProgress(jobId, 40, "Transcribing with Groq AI...");

    const fileStream = fs.createReadStream(audioPath);

    const transcription = await groq.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-large-v3-turbo",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
      task: translate ? "translate" : "transcribe",
    });

    sendProgress(jobId, 88, "Building captions...");

    if (!transcription.segments || transcription.segments.length === 0) {
      throw new Error("No speech detected in the video.");
    }

    const captions = transcription.segments.map((seg, i) => ({
      id: i + 1,
      start: parseFloat(seg.start.toFixed(2)),
      end: parseFloat(seg.end.toFixed(2)),
      text: seg.text.trim(),
    }));

    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}

    sendProgress(jobId, 100, "Done! 🎉");
    setTimeout(() => res.json(captions), 400);

  } catch (err) {
    console.error("❌ Groq error:", err.message || err);
    sendProgress(jobId, 0, "Error!");
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}
    res.status(500).json({ error: err.message || "Groq transcription failed" });
  }
});

// ── EXPORT ENDPOINT (FFmpeg) ──────────────────────────────────────────────────
app.post("/export", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const videoPath = path.resolve(req.file.path);
  const outputDir = path.resolve("uploads");
  const outputFile = path.join(outputDir, `export_${Date.now()}.mp4`);

  let captions = [];
  try {
    captions = JSON.parse(req.body.captions);
  } catch(e) {
    return res.status(400).json({ error: "Invalid captions" });
  }

  const style = JSON.parse(req.body.style || "{}");
  const fontSize = style.size || 24;

  // Build SRT file
  const srtPath = path.join(outputDir, `sub_${Date.now()}.srt`);
  const pad = (n) => String(Math.floor(n)).padStart(2, "0");
  const toSRTTime = (s) => {
    const h = pad(s / 3600);
    const m = pad((s % 3600) / 60);
    const sec = pad(s % 60);
    const ms = String(Math.round((s % 1) * 1000)).padStart(3, "0");
    return `${h}:${m}:${sec},${ms}`;
  };

  const srtContent = captions.map((c) =>
    `${c.id}\n${toSRTTime(c.start)} --> ${toSRTTime(c.end)}\n${c.text}`
  ).join("\n\n");

  fs.writeFileSync(srtPath, srtContent);

  const srtFixed = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  const ffmpegArgs = [
    "-i", videoPath,
    "-vf", `subtitles='${srtFixed}':force_style='FontSize=${fontSize},PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2'`,
    "-c:a", "copy",
    "-y",
    outputFile
  ];

  console.log("🎬 Running FFmpeg export...");

  const ffmpeg = spawn("ffmpeg", ffmpegArgs);

  ffmpeg.stderr.on("data", (data) => {
    console.log("FFmpeg:", data.toString().trim());
  });

  ffmpeg.on("close", (code) => {
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(srtPath); } catch(e) {}

    if (code !== 0) {
      console.error("❌ FFmpeg failed");
      return res.status(500).json({ error: "FFmpeg export failed" });
    }

    console.log("✅ Export done! Sending file...");

    res.download(outputFile, "GenerateYourCap_export.mp4", (err) => {
      if (err) console.error("Download error:", err);
      try { fs.unlinkSync(outputFile); } catch(e) {}
    });
  });
});

app.listen(5000, "0.0.0.0", () => {
  console.log("🚀 Server running on http://0.0.0.0:5000");
  console.log("   → Local:   http://localhost:5000");
});