import "dotenv/config";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { clipDrafts, clipJobs, type ClipDraft, type ClipJob } from "../drizzle/schema";
import { buildHighlightPlan } from "../server/clipforge/ai";
import { GUEST_LIMITS, inspectRemoteSource, isAllowedStatusTransition, type CreateJobInput } from "../server/clipforge/contracts";
import { getMediaDownloadUrl, putMedia } from "../server/clipforge/mediaStore";
import { updateClipDraft, updateClipJob } from "../server/db/clipJobs";
import { getDb } from "../server/db";
import { transcribeAudio } from "../server/_core/voiceTranscription";

const execFile = promisify(execFileCallback);
const POLL_MS = Math.max(1000, Number(process.env.CLIPFORGE_WORKER_POLL_MS || 5000));
const MAX_DURATION_MS = GUEST_LIMITS.maxSourceDurationMinutes * 60_000;
const SUPPORTED_UPLOAD_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);

type TranscriptResult = { text: string; timeCodedText: string };

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "media.mp4";
}

async function createWorkdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "clipforge-"));
}

async function downloadToFile(url: string, destination: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Media download failed with status ${response.status}.`);
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > GUEST_LIMITS.maxUploadBytes) throw new Error("The source exceeds the 250 MB guest limit.");
    let received = 0;
    const limiter = new TransformStream({
      transform(chunk, stream) {
        received += chunk.byteLength;
        if (received > GUEST_LIMITS.maxUploadBytes) {
          stream.error(new Error("The source exceeds the 250 MB guest limit."));
          return;
        }
        stream.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body.pipeThrough(limiter) as never), createWriteStream(destination));
  } finally {
    clearTimeout(timeout);
  }
}

async function probeDurationMs(sourcePath: string) {
  const { stdout } = await execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourcePath], { maxBuffer: 1024 * 1024 });
  const durationMs = Math.round(Number.parseFloat(stdout.trim()) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("The worker could not read a valid media duration.");
  if (durationMs > MAX_DURATION_MS) throw new Error(`Guest sources are limited to ${GUEST_LIMITS.maxSourceDurationMinutes} minutes.`);
  return durationMs;
}

async function extractAudio(sourcePath: string, targetPath: string) {
  await execFile("ffmpeg", ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "24k", targetPath], { maxBuffer: 1024 * 1024 });
}

async function transcribeAudioFile(audioPath: string, jobId: string): Promise<TranscriptResult> {
  if (process.env.BUILT_IN_FORGE_API_KEY && process.env.BUILT_IN_FORGE_API_URL) {
    const audio = await fs.readFile(audioPath);
    const stored = await putMedia(`clipforge/${jobId}/audio.m4a`, audio, "audio/mp4");
    const response = await transcribeAudio({ audioUrl: await getMediaDownloadUrl(stored.key), language: "en", prompt: "Transcribe short-form video speech with accurate segment timing." });
    if ("error" in response) throw new Error(response.details || response.error);
    const timeCodedText = response.segments.map(segment => `[${Math.round(segment.start * 1000)}-${Math.round(segment.end * 1000)}] ${segment.text}`).join("\n");
    return { text: response.text, timeCodedText };
  }
  throw new Error("Transcription is not configured for this deployment. Add a supported server-side transcription provider before processing media.");
}

function sourceInputForInspection(job: ClipJob): CreateJobInput {
  return { visitorId: job.visitorId, sourceKind: job.sourceKind, sourceUrl: job.sourceUrl || undefined, sourceName: job.sourceName || undefined, sourceMimeType: job.sourceMimeType || undefined, sourceSizeBytes: job.sourceSizeBytes || undefined, sourceStorageKey: job.sourceStorageKey || undefined, rightsConfirmed: true };
}

async function materializeSource(job: ClipJob, workdir: string) {
  const destination = path.join(workdir, safeFilename(job.sourceName || (job.sourceKind === "direct_url" ? "remote-source.mp4" : "source.mp4")));
  if (job.sourceStorageKey) {
    await downloadToFile(await getMediaDownloadUrl(job.sourceStorageKey), destination);
    return destination;
  }
  if (job.sourceKind === "youtube") throw new Error("YouTube imports require an approved source-provider integration. Upload an authorized local copy instead.");
  if (job.sourceKind !== "direct_url" || !job.sourceUrl) throw new Error("This job has no downloadable media source.");
  const inspection = await inspectRemoteSource(sourceInputForInspection(job));
  if (!inspection.ok) throw new Error(inspection.message);
  await downloadToFile(job.sourceUrl, destination);
  const stored = await putMedia(`clipforge/${job.id}/source-${safeFilename(path.basename(destination))}`, await fs.readFile(destination), "video/mp4");
  await updateClipJob(job.id, { sourceStorageKey: stored.key });
  return destination;
}

async function acquireQueuedJob() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for the worker.");
  const candidates = await db.select().from(clipJobs).where(eq(clipJobs.status, "queued")).orderBy(asc(clipJobs.createdAt)).limit(4);
  for (const job of candidates) {
    const result = await db.update(clipJobs).set({ status: "validating", progress: 10 }).where(and(eq(clipJobs.id, job.id), eq(clipJobs.status, "queued")));
    if (Number((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0) > 0) return { ...job, status: "validating" as const, progress: 10 };
  }
  return undefined;
}

async function acquireRenderDraft() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for the worker.");
  const [draft] = await db.select().from(clipDrafts).where(eq(clipDrafts.status, "rendering")).orderBy(asc(clipDrafts.updatedAt)).limit(1);
  if (!draft) return undefined;
  const [job] = await db.select().from(clipJobs).where(eq(clipJobs.id, draft.jobId)).limit(1);
  return job ? { draft, job } : undefined;
}

async function processAnalysisJob(job: ClipJob) {
  const workdir = await createWorkdir();
  try {
    const sourcePath = await materializeSource(job, workdir);
    const durationMs = await probeDurationMs(sourcePath);
    await updateClipJob(job.id, { status: "transcribing", progress: 35, errorCode: null, errorMessage: null });
    const audioPath = path.join(workdir, "audio.m4a");
    await extractAudio(sourcePath, audioPath);
    const transcript = await transcribeAudioFile(audioPath, job.id);
    await updateClipJob(job.id, { status: "analyzing", progress: 70, transcriptText: transcript.timeCodedText });
    const plan = await buildHighlightPlan(transcript.timeCodedText, durationMs);
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required for the worker.");
    const drafts = plan.candidates.slice(0, GUEST_LIMITS.maxClipsPerJob).map(candidate => ({
      id: crypto.randomUUID(), jobId: job.id, title: candidate.title.slice(0, 140), captionText: candidate.caption, startMs: candidate.startMs, endMs: candidate.endMs, aspectRatio: "9:16" as const, status: "suggested" as const, exportStorageKey: null, exportUrl: null,
    }));
    await db.insert(clipDrafts).values(drafts);
    await updateClipJob(job.id, { status: "ready", progress: 100, transcriptText: transcript.timeCodedText });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The worker could not process this source.";
    const blocked = /YouTube imports|not configured|access|public|limit|duration/i.test(message);
    await updateClipJob(job.id, { status: blocked ? "blocked" : "failed", progress: 0, errorCode: blocked ? "SOURCE_OR_CONFIGURATION_BLOCKED" : "PROCESSING_FAILED", errorMessage: message });
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

function videoFilter(aspectRatio: ClipDraft["aspectRatio"], caption: string | null) {
  const framing = aspectRatio === "9:16" ? "scale=1080:-2,crop=1080:1920" : aspectRatio === "1:1" ? "scale=1080:-2,crop=1080:1080" : "scale=1920:-2,crop=1920:1080";
  const escapedCaption = (caption || "").replace(/['\\:]/g, "\\$&").replace(/\n/g, " ").slice(0, 260);
  return escapedCaption ? `${framing},drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${escapedCaption}':fontcolor=white:fontsize=42:borderw=5:bordercolor=black@0.65:x=(w-text_w)/2:y=h-(text_h*2.4):alpha='if(lt(t,0.25),t/0.25,1)'` : framing;
}

async function renderDraft(draft: ClipDraft, job: ClipJob) {
  const workdir = await createWorkdir();
  try {
    const sourcePath = await materializeSource(job, workdir);
    const outputPath = path.join(workdir, `${draft.id}.mp4`);
    await execFile("ffmpeg", ["-y", "-ss", String(draft.startMs / 1000), "-to", String(draft.endMs / 1000), "-i", sourcePath, "-vf", videoFilter(draft.aspectRatio, draft.captionText), "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-c:a", "aac", "-movflags", "+faststart", outputPath], { maxBuffer: 1024 * 1024 });
    const stored = await putMedia(`clipforge/${job.id}/exports/${draft.id}.mp4`, await fs.readFile(outputPath), "video/mp4");
    await updateClipDraft(draft.id, job.id, { status: "completed", exportStorageKey: stored.key, exportUrl: stored.url });
    await updateClipJob(job.id, { status: "completed", progress: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The video export failed.";
    await updateClipDraft(draft.id, job.id, { status: "failed" });
    await updateClipJob(job.id, { status: "failed", progress: 0, errorCode: "RENDER_FAILED", errorMessage: message });
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

let isWorking = false;
async function tick() {
  if (isWorking) return;
  isWorking = true;
  try {
    const render = await acquireRenderDraft();
    if (render) await renderDraft(render.draft, render.job);
    else {
      const job = await acquireQueuedJob();
      if (job) await processAnalysisJob(job);
    }
  } catch (error) {
    console.error("[ClipForge worker] tick failed", error);
  } finally {
    isWorking = false;
  }
}

void tick();
setInterval(() => void tick(), POLL_MS);
