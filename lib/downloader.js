import youtubedl from "youtube-dl-exec";
import ffmpegPath from "ffmpeg-static";
import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export function setCors(req, res) {
  const origin = process.env.ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

export async function handleDownload(req, res, mode) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const body = req.body || {};
  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
  const getInfo = body.getInfo === true || body.getInfo === "true";

  if (!validYoutubeUrl(videoUrl)) {
    return res.status(400).json({
      error: "Invalid YouTube URL",
      details: "Send a valid youtube.com or youtu.be URL in JSON field videoUrl."
    });
  }

  let tempFilePath;
  try {
    const info = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noPlaylist: true,
      socketTimeout: 15,
      ...(ffmpegPath ? { ffmpegLocation: path.dirname(ffmpegPath) } : {})
    });

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
    const options = {
      output: tempFilePath,
      noWarnings: true,
      noCallHome: true,
      noPlaylist: true,
      socketTimeout: 15,
      ...(ffmpegPath ? { ffmpegLocation: path.dirname(ffmpegPath) } : {})
    };

    if (mode === "audio") {
      Object.assign(options, { extractAudio: true, audioFormat: "mp3", audioQuality: 0 });
    } else {
      options.format = typeof body.quality === "string" && body.quality.length < 80
        ? body.quality
        : "best[ext=mp4][acodec!=none]/best[ext=mp4]";
      options.mergeOutputFormat = "mp4";
    }

    await youtubedl(videoUrl, options);
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