import { z } from "zod";
import { lookup } from "node:dns/promises";
import net from "node:net";

function positiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export const GUEST_LIMITS = {
  maxUploadBytes: positiveIntegerEnv("CLIPFORGE_MAX_UPLOAD_MB", 250) * 1024 * 1024,
  maxSourceDurationMinutes: positiveIntegerEnv("CLIPFORGE_MAX_SOURCE_MINUTES", 60),
  maxClipsPerJob: positiveIntegerEnv("CLIPFORGE_MAX_CLIPS_PER_JOB", 3),
  maxExportsPerJob: positiveIntegerEnv("CLIPFORGE_MAX_EXPORTS_PER_JOB", 3),
  exportsEnabled: booleanEnv("CLIPFORGE_EXPORTS_ENABLED", true),
  retentionHours: positiveIntegerEnv("CLIPFORGE_RETENTION_HOURS", 24),
} as const;

export const ALLOWED_ASPECT_RATIOS = ["9:16", "1:1", "16:9"] as const;
export const sourceKinds = ["upload", "direct_url", "youtube"] as const;
export const jobStatuses = [
  "draft",
  "queued",
  "validating",
  "transcribing",
  "analyzing",
  "ready",
  "rendering",
  "completed",
  "blocked",
  "failed",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const createJobInput = z
  .object({
    visitorId: z.string().trim().min(20).max(80),
    sourceKind: z.enum(sourceKinds),
    sourceUrl: z.string().url().max(2048).optional(),
    sourceStorageKey: z.string().trim().min(1).max(512).optional(),
    sourceName: z.string().trim().min(1).max(255).optional(),
    sourceMimeType: z.string().trim().max(127).optional(),
    sourceSizeBytes: z.number().int().min(1).max(GUEST_LIMITS.maxUploadBytes).optional(),
    rightsConfirmed: z.literal(true, {
      error: "Confirm that you have rights or permission to process this media before continuing.",
    }),
  })
  .superRefine((input, ctx) => {
    if (input.sourceKind === "upload" && (!input.sourceName || !input.sourceMimeType || !input.sourceSizeBytes || !input.sourceStorageKey)) {
      ctx.addIssue({ code: "custom", message: "Choose a supported local video before starting a job.", path: ["sourceName"] });
    }
    if (input.sourceKind !== "upload" && !input.sourceUrl) {
      ctx.addIssue({ code: "custom", message: "Paste a permitted source URL before starting a job.", path: ["sourceUrl"] });
    }
  });

export type CreateJobInput = z.infer<typeof createJobInput>;

const SUPPORTED_UPLOAD_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);
const DIRECT_MEDIA_EXTENSIONS = /\.(mp4|webm|mov|m4v)(?:$|[?#])/i;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export type SourceValidation = { ok: true } | { ok: false; code: string; message: string };

export function validatePermittedSource(input: CreateJobInput): SourceValidation {
  if (!input.rightsConfirmed) {
    return { ok: false, code: "RIGHTS_CONFIRMATION_REQUIRED", message: "Confirm your rights or permission before processing media." };
  }

  if (input.sourceKind === "upload") {
    if (!input.sourceMimeType || !SUPPORTED_UPLOAD_MIMES.has(input.sourceMimeType)) {
      return { ok: false, code: "UNSUPPORTED_UPLOAD_TYPE", message: "Upload an MP4, WebM, MOV, or M4V video file." };
    }
    if (!input.sourceSizeBytes || input.sourceSizeBytes > GUEST_LIMITS.maxUploadBytes || !input.sourceStorageKey) {
      return { ok: false, code: "UPLOAD_LIMIT_EXCEEDED", message: "Guest uploads are limited to 250 MB. Trim or compress the source and try again." };
    }
    return { ok: true };
  }

  const sourceUrl = input.sourceUrl;
  if (!sourceUrl) return { ok: false, code: "MISSING_SOURCE_URL", message: "Paste a permitted source URL before starting a job." };

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return { ok: false, code: "INVALID_SOURCE_URL", message: "That link is not a valid URL. Use an HTTPS direct-media or permitted YouTube link." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, code: "INSECURE_SOURCE_URL", message: "Use an HTTPS URL so media can be checked safely." };
  }

  if (input.sourceKind === "youtube") {
    if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
      return { ok: false, code: "YOUTUBE_LINK_REQUIRED", message: "Choose YouTube only for a youtube.com or youtu.be link." };
    }
    return { ok: true };
  }

  if (!DIRECT_MEDIA_EXTENSIONS.test(parsed.pathname)) {
    return { ok: false, code: "DIRECT_MEDIA_LINK_REQUIRED", message: "Use a direct HTTPS link ending in .mp4, .webm, .mov, or .m4v. Pages, logins, and protected streams are not supported." };
  }

  return { ok: true };
}

function isPrivateOrReservedIp(address: string) {
  if (net.isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [first, second] = parts;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 192 && second === 2) ||
      (first === 198 && second === 51) ||
      (first === 203 && second === 0);
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

async function resolvesToPublicAddress(hostname: string) {
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(address => !isPrivateOrReservedIp(address.address));
  } catch {
    return false;
  }
}

export async function inspectRemoteSource(input: CreateJobInput): Promise<SourceValidation> {
  if (input.sourceKind === "upload") return { ok: true };
  const sourceUrl = input.sourceUrl;
  if (!sourceUrl) return { ok: false, code: "MISSING_SOURCE_URL", message: "Paste a permitted source URL before starting a job." };
  const parsed = new URL(sourceUrl);

  if (input.sourceKind === "youtube") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        return { ok: false, code: "YOUTUBE_UNAVAILABLE", message: "This YouTube source is unavailable for permitted processing. Confirm it is public, embeddable, and allowed for your use, or upload an authorized local copy." };
      }
      return { ok: true };
    } catch {
      return { ok: false, code: "YOUTUBE_CHECK_FAILED", message: "The YouTube source could not be checked right now. Confirm it is publicly available and try again later, or upload an authorized local file." };
    }
  }

  if (!(await resolvesToPublicAddress(parsed.hostname))) {
    return { ok: false, code: "UNSAFE_SOURCE_HOST", message: "This source cannot be checked from the processing service. Use a public HTTPS media host rather than a private, local, or internal address." };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(sourceUrl, { method: "HEAD", redirect: "manual", signal: controller.signal });
    clearTimeout(timeout);
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, code: "SOURCE_REDIRECT_NOT_ALLOWED", message: "The source redirects to another location. Provide the final direct HTTPS media URL instead." };
    }
    if (!response.ok) {
      return { ok: false, code: "SOURCE_UNAVAILABLE", message: `The source returned ${response.status}. Confirm the file is publicly reachable without a login, paywall, CAPTCHA, or other access control.` };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("video/")) {
      return { ok: false, code: "SOURCE_NOT_MEDIA", message: "The link did not return a video file. Use the final direct URL to a public MP4, WebM, MOV, or M4V file." };
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > GUEST_LIMITS.maxUploadBytes) {
      return { ok: false, code: "SOURCE_SIZE_LIMIT", message: "This source exceeds the 250 MB guest limit. Trim or compress an authorized copy before processing." };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "SOURCE_CHECK_FAILED", message: "The source could not be checked. Confirm it is a public direct HTTPS media file and does not require a login or access challenge." };
  }
}

export const allowedTransitions: Record<JobStatus, readonly JobStatus[]> = {
  draft: ["queued", "blocked", "failed"],
  queued: ["validating", "blocked", "failed"],
  validating: ["transcribing", "blocked", "failed"],
  transcribing: ["analyzing", "failed"],
  analyzing: ["ready", "failed"],
  ready: ["rendering", "failed"],
  rendering: ["completed", "failed"],
  completed: [],
  blocked: [],
  failed: [],
};

export function isAllowedStatusTransition(from: JobStatus, to: JobStatus) {
  return allowedTransitions[from].includes(to);
}
