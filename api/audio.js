import { handleDownload } from "../lib/downloader.js";

export default async function handler(req, res) {
  return handleDownload(req, res, "audio");
}