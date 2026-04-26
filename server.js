const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
}));
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

// ── GENERATE ENDPOINT ─────────────────────────────────────────────────────────
app.post("/generate", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const jobId = req.body.jobId || Date.now().toString();
  const videoPath = path.resolve(req.file.path);
  const outputDir = path.resolve("uploads");
  const baseName = req.file.filename;
  const translate = req.body.translate === "true";
  const language = req.body.language || null;

  console.log(`✅ Video received | translate: ${translate} | language: ${language}`);

  const args = [
    "-m", "whisper", videoPath,
    "--model", "tiny",
    "--output_format", "json",
    "--output_dir", outputDir,
  ];

  if (translate) { args.push("--task", "translate"); }
  else { args.push("--task", "transcribe"); }
  if (language) { args.push("--language", language); }

  console.log("🎙️ Running Whisper:", args.join(" "));

  const whisper = spawn("python", args);
  let totalDuration = null;
  let lastPercent = 10;

  sendProgress(jobId, 10, "Extracting audio...");

  whisper.stderr.on("data", (data) => {
    const text = data.toString();
    console.log("Whisper:", text.trim());

    const durMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+)/);
    if (durMatch) {
      totalDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
    }

    const segMatch = text.match(/\[(\d+):(\d+\.\d+) --> (\d+):(\d+\.\d+)\]/);
    if (segMatch && totalDuration) {
      const current = parseInt(segMatch[1]) * 60 + parseFloat(segMatch[2]);
      const pct = Math.min(90, Math.round(10 + (current / totalDuration) * 80));
      if (pct > lastPercent) { lastPercent = pct; sendProgress(jobId, pct, `Transcribing... ${pct}%`); }
    }
  });

  whisper.on("close", (code) => {
    if (code !== 0) {
      sendProgress(jobId, 0, "Error!");
      return res.status(500).json({ error: "Whisper failed" });
    }

    sendProgress(jobId, 92, "Building captions...");
    const jsonPath = path.join(outputDir, baseName + ".json");

    if (!fs.existsSync(jsonPath)) {
      return res.status(500).json({ error: "Whisper output not found" });
    }

    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const captions = raw.segments.map((seg, i) => ({
        id: i + 1,
        start: parseFloat(seg.start.toFixed(2)),
        end: parseFloat(seg.end.toFixed(2)),
        text: seg.text.trim(),
      }));

      try { fs.unlinkSync(videoPath); } catch(e) {}
      try { fs.unlinkSync(jsonPath); } catch(e) {}

      sendProgress(jobId, 100, "Done! 🎉");
      setTimeout(() => res.json(captions), 400);

    } catch (parseErr) {
      res.status(500).json({ error: "Failed to parse Whisper output" });
    }
  });
});

// ── EXPORT ENDPOINT ───────────────────────────────────────────────────────────
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

  // ✅ FIX: Windows path — backslash to forward slash + colon escape
  const srtFixed = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  const ffmpegArgs = [
    "-i", videoPath,
    "-vf", `subtitles='${srtFixed}':force_style='FontSize=${fontSize},PrimaryColour=&H00ffffff,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2'`,
    "-c:a", "copy",
    "-y",
    outputFile
  ];

  console.log("🎬 Running FFmpeg export...");
  console.log("SRT path:", srtFixed);

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