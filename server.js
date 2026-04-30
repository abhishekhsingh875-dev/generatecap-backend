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

// ── HELPER: Split long captions into small word chunks ────────────────────────
function chunkCaptions(segments, wordsPerChunk = 4) {
  const chunked = [];
  let id = 1;

  segments.forEach(seg => {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    const duration = seg.end - seg.start;
    const timePerWord = duration / words.length;

    for (let i = 0; i < words.length; i += wordsPerChunk) {
      const chunk = words.slice(i, i + wordsPerChunk).join(" ");
      const start = parseFloat((seg.start + i * timePerWord).toFixed(2));
      const end = parseFloat((seg.start + Math.min((i + wordsPerChunk) * timePerWord, duration)).toFixed(2));
      chunked.push({ id: id++, start, end, text: chunk });
    }
  });

  return chunked;
}

// ── GENERATE ENDPOINT (Groq AI) ───────────────────────────────────────────────
app.post("/generate", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const jobId = req.body.jobId || Date.now().toString();
  const videoPath = path.resolve(req.file.path);
  const audioPath = videoPath + "_audio.mp3";
  const translate = req.body.translate === "true";
  const wordsPerChunk = parseInt(req.body.wordsPerChunk) || 4;

  console.log(`✅ Video received | translate: ${translate} | wordsPerChunk: ${wordsPerChunk}`);

  try {
    sendProgress(jobId, 10, "Extracting audio...");

    // Extract audio with FFmpeg
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn("ffmpeg", [
        "-i", videoPath,
        "-vn",
        "-acodec", "mp3",
        "-ar", "16000",
        "-ac", "1",
        "-y",
        audioPath
      ]);
      ffmpeg.stderr.on("data", (d) => console.log("FFmpeg:", d.toString().trim()));
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("FFmpeg audio extraction failed"));
      });
    });

    // Check audio file size
    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`📦 Audio size: ${fileSizeMB.toFixed(2)} MB`);

    if (fileSizeMB > 24) {
      sendProgress(jobId, 0, "File too large! Max ~24MB audio.");
      try { fs.unlinkSync(videoPath); } catch(e) {}
      try { fs.unlinkSync(audioPath); } catch(e) {}
      return res.status(400).json({ error: "Audio too large for Groq (max 25MB). Please upload a shorter video." });
    }

    sendProgress(jobId, 40, "Transcribing with Groq AI...");

    // ✅ Fix: Read file into buffer and wrap with proper name+type for Groq
    const { toFile } = require("groq-sdk");
    const audioBuffer = fs.readFileSync(audioPath);
    const fileObj = await toFile(audioBuffer, "audio.mp3", { type: "audio/mpeg" });

    let transcription;

    if (translate) {
      transcription = await groq.audio.translations.create({
        file: fileObj,
        model: "whisper-large-v3",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });
    } else {
      transcription = await groq.audio.transcriptions.create({
        file: fileObj,
        model: "whisper-large-v3-turbo",
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });
    }

    sendProgress(jobId, 85, "Building captions...");

    if (!transcription.segments || transcription.segments.length === 0) {
      throw new Error("No speech detected in the video.");
    }

    // Split into word chunks for clean mobile display
    const captions = chunkCaptions(transcription.segments, wordsPerChunk);

    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}

    sendProgress(jobId, 100, "Done! 🎉");
    console.log(`✅ Done — ${captions.length} caption chunks`);
    setTimeout(() => res.json(captions), 400);

  } catch (err) {
    console.error("❌ Error:", err.message || err);
    sendProgress(jobId, 0, "Error!");
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(audioPath); } catch(e) {}
    res.status(500).json({ error: err.message || "Transcription failed" });
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

  // Build SRT
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
  ffmpeg.stderr.on("data", (data) => console.log("FFmpeg:", data.toString().trim()));

  ffmpeg.on("close", (code) => {
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(srtPath); } catch(e) {}

    if (code !== 0) {
      console.error("❌ FFmpeg export failed");
      return res.status(500).json({ error: "FFmpeg export failed" });
    }

    console.log("✅ Export done!");
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