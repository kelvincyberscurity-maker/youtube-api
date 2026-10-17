import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import ffmpegPath from "ffmpeg-static";
import { createReadStream } from "node:fs";
import { stat, unlink, access, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";

export function setCors(req, res) {
  const origin = process.env.ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Disposition");
}

export function validYoutubeUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) return false;
    if (host === "youtu.be") return u.pathname.length > 1;
    return u.pathname === "/watch" ? Boolean(u.searchParams.get("v")) :
      /^\/(shorts|live|embed)\/[\w-]+/.test(u.pathname);
  } catch {
    return false;
  }
}

export function safeName(value, fallback = "youtube-download") {
  const cleaned = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

async function getYtDlp() {
  // Download the standalone Linux x86_64 yt-dlp binary to Vercel's writable /tmp.
  const binaryPath = path.join(os.tmpdir(), "yt-dlp");
  try {
    await access(binaryPath, constants.X_OK);
    return binaryPath;
  } catch {
    const response = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux");
    if (!response.ok) throw new Error(`Unable to download yt-dlp binary (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1_000_000) throw new Error("Downloaded yt-dlp binary is unexpectedly small");
    await writeFile(binaryPath, bytes);
    await chmod(binaryPath, 0o755);
    return binaryPath;
  }
}

async function runYtDlp(binaryPath, args) {
  const { stdout, stderr } = await execFileAsync(binaryPath, args, {
    timeout: 50000,
    maxBuffer: 8 * 1024 * 1024
  });
  return { stdout, stderr };
}

export async function handleDownload(req, res, mode) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  }

  // GET makes it possible to start a download from a browser address bar.
  // POST remains supported for clients that send JSON.
  const body = req.method === "GET" ? (req.query || {}) : (req.body || {});
  const rawUrl = body.videoUrl ?? body.url;
  const videoUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
  const getInfo = body.getInfo === true || body.getInfo === "true";

  if (!validYoutubeUrl(videoUrl)) {
    return res.status(400).json({
      error: "Invalid YouTube URL",
      details: "Send a valid YouTube URL using ?url=ENCODED_URL (GET) or JSON field videoUrl/url (POST)."
    });
  }

  let tempFilePath;
  try {
    const ytdlp = await getYtDlp();
    const commonArgs = [
      "--no-warnings",
      "--no-call-home",
      "--no-playlist",
      "--socket-timeout", "15",
      ...(ffmpegPath ? ["--ffmpeg-location", path.dirname(ffmpegPath)] : [])
    ];
    const infoResult = await runYtDlp(ytdlp, [
      "--dump-single-json", videoUrl, ...commonArgs
    ]);
    const info = JSON.parse(infoResult.stdout);

    if (getInfo) {
      const formats = (info.formats || [])
        .filter(f => mode === "video"
          ? f.ext === "mp4" && f.vcodec !== "none" && f.acodec !== "none"
          : f.acodec !== "none")
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || null,
          quality: f.quality ?? null,
          filesize: f.filesize || f.filesize_approx || null,
          audio_bitrate: f.abr || null
        }));
      return res.status(200).json({
        title: info.title,
        id: info.id,
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        formats
      });
    }

    // Vercel only provides temporary writable storage in /tmp.
    // Each invocation gets a unique filename to avoid collisions.
    const id = randomUUID();
    const ext = mode === "audio" ? "mp3" : "mp4";
    tempFilePath = path.join(os.tmpdir(), `yt-${id}.${ext}`);
    const args = [
      videoUrl,
      "--output", tempFilePath,
      ...commonArgs
    ];

    if (mode === "audio") {
      args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
    } else {
      const quality = typeof body.quality === "string" && body.quality.length < 80
        ? body.quality
        : "best[ext=mp4][acodec!=none]/best[ext=mp4]";
      args.push("--format", quality, "--merge-output-format", "mp4");
    }

    await runYtDlp(ytdlp, args);
    const fileStat = await stat(tempFilePath);
    const fileSize = fileStat.size;
    const filename = `${safeName(info.title)}.${ext}`;
    res.setHeader("Content-Type", mode === "audio" ? "audio/mpeg" : "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        await unlink(tempFilePath).catch(() => {});
        return res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
      }
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : fileSize - 1;
      if (!match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Math.max(0, fileSize - suffix);
        end = fileSize - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileSize) {
        await unlink(tempFilePath).catch(() => {});
        return res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
      }
      end = Math.min(end, fileSize - 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", end - start + 1);
      const stream = createReadStream(tempFilePath, { start, end });
      stream.on("error", err => {
        console.error("Media stream error:", err.message);
        if (!res.headersSent) res.status(500).end();
      });
      stream.on("close", () => unlink(tempFilePath).catch(() => {}));
      return stream.pipe(res);
    }

    res.setHeader("Content-Length", fileSize);
    const stream = createReadStream(tempFilePath);
    stream.on("error", err => {
      console.error("Media stream error:", err.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.on("close", () => unlink(tempFilePath).catch(() => {}));
    return stream.pipe(res);
  } catch (error) {
    if (tempFilePath) await unlink(tempFilePath).catch(() => {});
    console.error("YouTube downloader error:", error?.stderr || error?.message || error);
    if (!res.headersSent) {
      return res.status(502).json({
        error: mode === "audio" ? "Failed to process YouTube audio" : "Failed to process YouTube video",
        details: String(error?.stderr || error?.message || "Unknown downloader error").slice(0, 1200),
        hint: "YouTube extraction, FFmpeg availability, execution time, and serverless response limits can affect downloads."
      });
    }
  }
}