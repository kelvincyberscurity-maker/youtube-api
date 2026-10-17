# YouTube Downloader API — Vercel edition

Node.js serverless API for YouTube video (MP4) and audio (MP3).

## Deploy to Vercel

1. Extract this ZIP.
2. Upload the project to a GitHub repository.
3. Import the repository in Vercel.
4. Keep the framework preset as **Other**. Do not set a custom build command.
5. Deploy. Endpoints will be:
   - `GET /api/health`
   - `POST /api/youtube`
   - `POST /api/audio`

## Test requests

### Video info
```bash
curl -X POST "https://YOUR-PROJECT.vercel.app/api/youtube" \
  -H "Content-Type: application/json" \
  -d '{"videoUrl":"https://www.youtube.com/watch?v=VIDEO_ID","getInfo":true}'
```

### Download MP4
```bash
curl -L -X POST "https://YOUR-PROJECT.vercel.app/api/youtube" \
  -H "Content-Type: application/json" \
  -d '{"videoUrl":"https://www.youtube.com/watch?v=VIDEO_ID"}' \
  --output video.mp4
```

### Download MP3
```bash
curl -L -X POST "https://YOUR-PROJECT.vercel.app/api/audio" \
  -H "Content-Type: application/json" \
  -d '{"videoUrl":"https://www.youtube.com/watch?v=VIDEO_ID"}' \
  --output audio.mp3
```

### Audio info
```bash
curl -X POST "https://YOUR-PROJECT.vercel.app/api/audio" \
  -H "Content-Type: application/json" \
  -d '{"videoUrl":"https://www.youtube.com/watch?v=VIDEO_ID","getInfo":true}'
```

Request body uses `videoUrl`, not `url`. For MP4, optional `quality` can be a yt-dlp format selector.

## Important Vercel limitations

This is adapted to Vercel Functions: it uses `/tmp`, unique temporary filenames, serverless handler exports, and `/api/*` routes instead of starting an Express server. It is **not possible to guarantee every download will work on Vercel**. YouTube may change its extraction flow, bundled downloader/FFmpeg binaries may fail in a deployment environment, and Vercel's function duration, memory, bundle-size, and response-size limits can prevent large or long downloads. For large files or reliable production downloads, use a VPS or external worker/storage service.

Only download videos/audio you own or are authorized to download, and comply with YouTube's terms and applicable law.


## Browser-friendly GET endpoints

The API also accepts GET requests so you can start a download by opening a URL in a browser. URL-encode the YouTube URL as the `url` parameter:

- MP3: `/api/audio?url=https%3A%2F%2Fyoutu.be%2FVIDEO_ID`
- MP4: `/api/youtube?url=https%3A%2F%2Fyoutu.be%2FVIDEO_ID`
- Audio/video metadata: append `&getInfo=true`

If the YouTube URL contains its own query parameters (such as `?si=...`), encode the entire YouTube URL in the `url` parameter. For example, use JavaScript `encodeURIComponent(youtubeUrl)` when generating links. GET downloads may still fail for large media because of Vercel serverless limits.


## Fix for `env: 'python3': No such file or directory`
This version downloads the standalone yt-dlp binary to `/tmp` on a cold start, avoiding the Python-script wrapper that requires `python3`. Vercel network access and function duration limits still apply.
