# ClipForge AI

**ClipForge AI** is a guest-accessible, rights-aware short-video clipping workspace. It accepts local video uploads, direct public media URLs, and validated YouTube links for permitted use; it then routes valid jobs through source checks, transcription, Gemini-assisted highlight selection, editable draft ranges, caption direction, and FFmpeg exports.

> **Permission boundary.** Before any job is created, a guest must confirm they own the media or have permission to process and export it. The app does not bypass CAPTCHAs, access controls, logins, paywalls, bot mitigation, or platform restrictions. Sources that need them are stopped and explained rather than worked around.

## What the MVP includes

| Area | Current behavior |
| --- | --- |
| Guest access | A browser-local guest identifier isolates job records without requiring a sign-in flow. |
| Ingestion | Supports local MP4, WebM, MOV, and M4V files up to 250 MB, direct public HTTPS media files, and validated YouTube links. |
| Protection | Enforces rights confirmation, HTTPS, safe public host checks, allowed direct-media extensions, MIME checks, file limits, and actionable blocked-source states. |
| Editing | Persists time-range drafts, a title, caption direction, and only **9:16**, **1:1**, or **16:9** output choices. |
| AI | Uses the server-side `GEMINI_API_KEY` as the primary provider; the managed preview provider is a fallback. Gemini requests use structured JSON for highlight plans. |
| Worker | A Render background worker uses FFmpeg/FFprobe for duration probing and rendering, then saves exports in S3-compatible storage. |

The model provider is intentionally separated from the browser. The external Gemini endpoint accepts a server-side `systemInstruction`, `contents`, and generation configuration; those are the request structures used by the provider adapter.[1]

## Production deployment: Vercel browser + Render processing

The repository deliberately separates the browser from the resource-intensive API and worker. Vercel serves the Vite client, while Render runs the API and a Docker-backed worker with FFmpeg. This avoids trying to carry out video rendering inside a request-scoped frontend deployment.

| Service | Repository configuration | Required configuration |
| --- | --- | --- |
| Vercel frontend | `vercel.json` runs `pnpm vite build` and publishes `dist/public`. | Set `VITE_API_BASE_URL` to the public Render API URL. |
| Render API | `render-api/Dockerfile` builds the React client and Express/tRPC server; `render.yaml` exposes `/health`. | Set `CLIPFORGE_WEB_ORIGIN` to the exact Vercel origin and provide database, Gemini, and object-storage values. |
| Render worker | `render-worker/Dockerfile` installs FFmpeg and fonts, then polls queued jobs. | Use the same database, Gemini key, and S3-compatible object-storage configuration as the API. |

Vercel documents that Vite deployments expose build-time variables only when they use the `VITE_` prefix, which is why `VITE_API_BASE_URL` contains only the public API address—**never** a secret.[2] The included SPA rewrite follows Vercel’s documented deep-link pattern.[2] Render Blueprints support Docker-backed background workers with `dockerfilePath` and `dockerContext`; their current documentation also states that workers require a paid plan rather than the free tier.[3]

### Deploy in order

First, create an S3-compatible bucket and a MySQL/TiDB-compatible database, then set the values in the following table for both Render services. The public storage URL is optional because the app can issue short-lived download URLs; storing an `S3_PUBLIC_BASE_URL` is useful only when you intentionally want public object URLs.

| Variable | Set on | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Vercel | Public Render API URL, with no trailing slash. |
| `CLIPFORGE_WEB_ORIGIN` | Render API | Exact production Vercel origin, used for CORS allowlisting. |
| `DATABASE_URL` | Render API and worker | MySQL/TiDB-compatible connection string shared by jobs and drafts. |
| `GEMINI_API_KEY` | Render API and worker | Server-side key for highlight analysis and the clip assistant. |
| `CLIPFORGE_GEMINI_MODEL` | Render API and worker | Optional Gemini model override; default is `gemini-2.5-flash`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Render API and worker | Credentials and target bucket for source/export media. |
| `S3_ENDPOINT`, `S3_PUBLIC_BASE_URL` | Render API and worker | Optional S3-compatible endpoint and intentional public base URL. |
| `CLIPFORGE_WORKER_POLL_MS` | Render worker | Optional polling interval; default is 5000 milliseconds. |
| `CLIPFORGE_MAX_UPLOAD_MB`, `CLIPFORGE_MAX_SOURCE_MINUTES`, `CLIPFORGE_MAX_CLIPS_PER_JOB`, `CLIPFORGE_RETENTION_HOURS` | Render API and worker | Optional operational limits. Defaults are 250 MB, 60 minutes, three clips, and 24 hours. |
| `CLIPFORGE_MAX_EXPORTS_PER_JOB`, `CLIPFORGE_EXPORTS_ENABLED` | Render API and worker | Guest export cap and enable switch. Defaults are three exports and `true`; queueing is rejected once the cap is reached or exports are disabled. |

Next, create the Render Blueprint from `render.yaml`. The API is a public web service and the worker is a background process. Enter `GEMINI_API_KEY` only in Render’s server-side environment configuration, along with the S3 and database values. The worker currently has a clear failure state if transcription is unavailable. For production, configure a server-side speech-to-text provider compatible with your storage model before admitting large-volume jobs.

Finally, import the same repository into Vercel, set `VITE_API_BASE_URL` to the deployed Render API (for example, `https://clipforge-api.onrender.com`), and deploy. Once Vercel provides the final site URL, copy that URL into Render as `CLIPFORGE_WEB_ORIGIN`; this restricts cross-origin browser requests to the known frontend.

## Processing lifecycle

```text
rights confirmation → source validation → queued → FFmpeg duration check
→ transcription → Gemini highlight plan → editable drafts → render queue
→ FFmpeg captioned export → S3-compatible object storage → download
```

The worker supports local uploads and direct public media URLs. A YouTube link is validated for availability, but **rendering a YouTube source requires an approved, rights-compliant source-provider integration**; otherwise the worker stops with an explicit instruction to upload an authorized local copy. This prevents the application from becoming a downloader for protected or unauthorized platform media.

## Reliability and operating limits

Guest limits are intentionally conservative: 250 MB per source, 60 minutes per source, up to three suggested clips per job, and 24-hour intended retention. The worker checks media duration with FFprobe before transcription and processes one job at a time per worker process to reduce memory pressure. Scale by adding workers only after replacing the simple database polling with a durable queue and ensuring that storage, transcription, and rate limits can absorb the added concurrency.

The application stores only object references in the database. Use a retention job or storage lifecycle policy to remove source and export objects after the guest retention window. Never place video assets in the Git repository or frontend public directory.

## Local development

```bash
pnpm install
pnpm check
pnpm test
pnpm dev
```

The browser workspace runs without a local FFmpeg worker. For local video processing, run the worker only in an environment with FFmpeg, a configured database, server-side Gemini credentials, and compatible object storage. Avoid putting any API key in `VITE_*` variables or committing `.env` files.

## References

[1] [Google AI for Developers, *GenerateContent API reference*](https://ai.google.dev/api/generate-content)

[2] [Vercel, *Vite on Vercel*](https://vercel.com/docs/frameworks/frontend/vite)

[3] [Render, *Blueprint YAML Reference*](https://render.com/docs/blueprint-spec)
