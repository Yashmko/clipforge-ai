# Project TODO

- [x] Define guest job and clip data models with explicit rights-confirmation state.
- [x] Build the International Typographic Style workspace shell with a responsive asymmetric grid, white canvas, black type, red accents, and visible usage limits.
- [x] Add a required rights-and-permission confirmation before any source can be analyzed or processed.
- [x] Implement guest source intake for local uploads, direct media URLs, and permitted YouTube links, with precise unavailable or blocked-source feedback.
- [x] Add database-backed job records and browser-visible status/progress states for validation, transcription, highlight analysis, and rendering.
- [x] Add configurable guest limits for source duration, file size, clips per job, and export availability.
- [x] Build the interactive clip editor with highlight-range selection, title and caption editing, and 9:16, 1:1, and 16:9 format choices only.
- [x] Implement a Gemini-first provider contract for contextual clip assistance and highlight-plan analysis, with a future-compatible model-provider boundary.
- [x] Define the server-side FFmpeg rendering contract for animated captions and downloadable exports without embedding a prohibited access-control bypass.
- [x] Add a clear processing architecture for a Vercel frontend and a Render API/worker, including environment-variable and deployment guidance.
- [x] Add automated tests for permissions, source validation, allowed aspect ratios, job-state transitions, and highlight-plan validation.
- [x] Verify the desktop and mobile workspace interfaces, record deployment assumptions, and checkpoint the completed project.
- [x] Implement safe server-side reachability checks for direct media URLs and persist actionable blocked or unavailable source statuses without following protected access flows.
- [x] Enforce the guest source-duration policy through media probing in the Render worker, with a clear “source too long” job status.
- [x] Define and enforce guest export availability and limits through deployment-time environment configuration.
- [x] Use environment-backed guest clip/export limits consistently in manual draft creation and render-queue eligibility.
- [x] Create the final verified project checkpoint after all outstanding implementation gaps are closed.
