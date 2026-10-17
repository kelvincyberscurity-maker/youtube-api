export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }
  return res.status(200).json({
    status: "ok",
    service: "YouTube Downloader API",
    endpoints: {
      video: "POST /api/youtube",
      audio: "POST /api/audio"
    },
    note: "Serverless limits may prevent long or large downloads."
  });
}